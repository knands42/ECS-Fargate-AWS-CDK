import { Duration, Stack, StackProps, aws_certificatemanager, aws_ec2, aws_ecr, aws_ecs, aws_elasticloadbalancingv2, aws_events, aws_events_targets, aws_iam, aws_lambda, aws_logs, aws_route53, aws_route53_targets } from "aws-cdk-lib";
import { Construct } from "constructs";
import path = require("path");

interface VpcStackProps extends StackProps {
    natGateways: number
    domainName: string;
    hostedZoneId: string;
    subDomainName: string;
}

export class MainStack extends Stack {
    public vpc: aws_ec2.IVpc
    public sg: aws_ec2.ISecurityGroup
    private ecrTag: string = 'latest'
    private serviceName: string = 'app'
    private containerPort: number = 8080

    /**
     * Creates a VPC with the given number of NAT Gateways and creates an
     * ECS security group that allows incoming traffic on port 80 from anywhere.
     *
     * @param scope the parent construct
     * @param id the id of the stack
     * @param props the stack properties
     */
    constructor(scope: Construct, id: string, props: VpcStackProps) {
        super(scope, id, props);
        const { natGateways, domainName, hostedZoneId, subDomainName } = props;

        const vpc = this.createVpc('custom-vpc', natGateways);
        const ecsSecurityGroup = this.createEcsSecurityGroup(vpc)
        
        const cert = this.createCertificate(domainName, hostedZoneId);
        const repo = this.createRepository('my-repo');

        const cluster = this.createCluster('main', vpc);
        const alb = this.createAlb('main', vpc);
        const listener = this.createAlbListener(alb, cert);

        const envVars = {
            PORT: this.containerPort.toString(),
        }
        const taskDefinition = this.taskDefinition('main', this.ecrTag, repo, 256, 512, this.containerPort, envVars);
        const fargateService = this.createService(cluster, listener, ecsSecurityGroup, taskDefinition, this.serviceName);
        this.createAlbDomain(alb, domainName, hostedZoneId, subDomainName);

        const lambdaFunction = this.lambda(cluster, fargateService, taskDefinition);
        this.eventBridge(repo, lambdaFunction);
    }

    private createVpc(vpcName: string, natGateways: number): aws_ec2.Vpc {
        const vpc = new aws_ec2.Vpc(this, 'custom-vpc', {
            vpcName,
            maxAzs: 2,
            natGateways,
            subnetConfiguration: [
                {
                  cidrMask: 24,
                  name: 'public',
                  subnetType: aws_ec2.SubnetType.PUBLIC,
                },
                {
                  cidrMask: 24,
                  name: 'private',
                  subnetType: aws_ec2.SubnetType.PRIVATE_WITH_EGRESS,
                },
                {
                  cidrMask: 24,
                  name: 'isolated',
                  subnetType: aws_ec2.SubnetType.PRIVATE_ISOLATED,
                },
            ],
        })

        return vpc
    }

    private createEcsSecurityGroup(vpc: aws_ec2.IVpc): aws_ec2.SecurityGroup {
        const sg = new aws_ec2.SecurityGroup(this, 'ecs-security-group', {
            securityGroupName: 'ecs',
            vpc: vpc,
            allowAllOutbound: true
        })
        
        sg.addIngressRule(aws_ec2.Peer.anyIpv4(), aws_ec2.Port.tcp(80), 'All TCP Ports')
        this.sg = sg
        return sg
    }

    private createCertificate(domainName: string, hostedZoneId: string) {
        const hostedZone = aws_route53.HostedZone.fromHostedZoneAttributes(this, `${hostedZoneId}MainZone`, {
          hostedZoneId,
          zoneName: domainName,
        });
    
        const certificate = new aws_certificatemanager.Certificate(this, `${hostedZoneId}MainCert`, {
          domainName,
          subjectAlternativeNames: [`*.${domainName}`],
          validation: aws_certificatemanager.CertificateValidation.fromDns(hostedZone),
        });
    
        return certificate;
      }

    private createRepository(repositoryName: string): aws_ecr.IRepository {
        const repository = new aws_ecr.Repository(this, `ecr`, {
            repositoryName: repositoryName,
            imageScanOnPush: false
        })

        repository.addLifecycleRule({ maxImageCount: 10 })

        return repository
    }

    private createCluster(name: string, vpc: aws_ec2.IVpc) {
        const cluster = new aws_ecs.Cluster(this, `${name}-cluster`, {
            clusterName: name,
            vpc: vpc,
            containerInsights: true,
            enableFargateCapacityProviders: true,
        });
    
        return cluster;
    }

    /**
     * Creates an Elastic Load Balancer (ELB) for the given stack.
     *
     * @param name the name of the ELB
     * @param vpc the VPC to create the ELB in
     * @returns the created ELB
     */
    private createAlb(name: string, vpc: aws_ec2.IVpc) {
        const loadBalancer = new aws_elasticloadbalancingv2.ApplicationLoadBalancer(this, 'ALB', {
            loadBalancerName: name,
            vpc: vpc,
            internetFacing: true,
          });

        return loadBalancer
    }
    
    /**
     * Creates an HTTPS listener for the given Application Load Balancer (ALB)
     * and SSL certificate.
     *
     * @param alb the ALB to create the listener for
     * @param certificate the SSL certificate to use for the listener
     * @returns the created listener
     */
    // TODO: add support for multiple listeners, https for public subnet and http for private subnet
    private createAlbListener(alb: aws_elasticloadbalancingv2.ApplicationLoadBalancer, certificate: aws_certificatemanager.ICertificate) {
        const listener = alb.addListener(`HttpsListener`, {
          port: 443,
          certificates: [certificate],
        });
    
        return listener;
    }

    /**
     * Creates an A record in the given hosted zone for the given subdomain, pointing to the given ALB.
     *
     * @param alb the ALB to point the A record at
     * @param domainName the domain name of the hosted zone
     * @param zoneId the ID of the hosted zone
     * @param subDomain the subdomain to create the A record for
     */
    private createAlbDomain(alb: aws_elasticloadbalancingv2.ApplicationLoadBalancer, domainName: string, zoneId: string, subDomain: string) {
        const hostedZone = aws_route53.HostedZone.fromHostedZoneAttributes(this, `${subDomain}-hosted-zone`, {
            hostedZoneId: zoneId,
            zoneName: domainName,
        });

        new aws_route53.ARecord(this, `${subDomain}Record`, {
            zone: hostedZone,
            recordName: subDomain,
            target: aws_route53.RecordTarget.fromAlias(new aws_route53_targets.LoadBalancerTarget(alb)),
        });
    }

    /**
     * Creates a Fargate task definition with a single container.
     *
     * The container is configured with the given CPU and memory limits, and
     * is given the given name. The container is also given the given
     * environment variables.
     *
     * The task definition is granted access to Secrets Manager, and is
     * configured to log to CloudWatch Logs with a retention period of one
     * day.
     *
     * @param serviceName The name of the task definition and its container.
     * @param ecrTag The tag of the ECR repository to use for the container's
     * image.
     * @param repository The ECR repository containing the image.
     * @param cpu The CPU limit for the container, in units of 10^2 CPU
     * shares. Defaults to 256 (1 vCPU).
     * @param memory The memory limit for the container, in MiB. Defaults to
     * 512.
     * @param containerPort The port number to expose from the container.
     * Defaults to 8080.
     * @param envVars Additional environment variables to set in the
     * container.
     */
    private taskDefinition(
        serviceName: string,
        ecrTag: string,
        repository: aws_ecr.IRepository,
        cpu: number = 256, 
        memory: number = 512,
        containerPort: number = 8080,
        envVars: { [key: string]: string } = {}
    ): aws_ecs.FargateTaskDefinition {
        const taskDefinition = new aws_ecs.FargateTaskDefinition(this, `${serviceName}-task-def`, {
            family: serviceName,
            memoryLimitMiB: memory,
            cpu: cpu,
            runtimePlatform: {
                operatingSystemFamily: aws_ecs.OperatingSystemFamily.LINUX,
                cpuArchitecture: aws_ecs.CpuArchitecture.X86_64,
            }
        })

        taskDefinition.addToTaskRolePolicy(new aws_iam.PolicyStatement({
            actions: ['secretsmanager:GetSecretValue'],
            resources: ['*'],
        }))

        taskDefinition.addContainer(`${serviceName}-container`, {
            containerName: serviceName,
            image: aws_ecs.ContainerImage.fromEcrRepository(repository, ecrTag),
            environment: envVars,
            secrets: {},
            logging: aws_ecs.LogDriver.awsLogs({
                streamPrefix: serviceName,
                mode: aws_ecs.AwsLogDriverMode.NON_BLOCKING,
                logRetention: aws_logs.RetentionDays.ONE_DAY,
            }),
            // healthCheck: {
            //     command: ['CMD-SHELL', 'curl --fail http://localhost:8080/health || exit 1'],
            //     interval: Duration.seconds(30),
            // },
            portMappings: [{ containerPort }]
        })

        return taskDefinition
    }

    /**
     * Creates a Fargate service with autoscaling and adds it to the given
     * ALB listener.
     *
     * The service is configured to run one task at a time, and is given a
     * security group that allows incoming HTTP traffic. The task definition
     * is also configured to allow executing command-line commands on the
     * container.
     *
     * The service is then added to the given listener with a health check
     * that checks the `/health` endpoint.
     *
     * @param cluster The ECS cluster to deploy the service to.
     * @param listener The ALB listener to add the service to.
     * @param sg The security group to assign to the service. This should allow
     * incoming HTTP traffic.
     * @param taskDefinition The task definition to use for the service.
     * @param serviceName The name of the service, which is also used as the
     * name of the task definition.
     *
     * @returns The created service.
     */
    private createService(
        cluster: aws_ecs.ICluster,
        listener: aws_elasticloadbalancingv2.ApplicationListener, 
        sg: aws_ec2.ISecurityGroup, 
        taskDefinition: aws_ecs.FargateTaskDefinition,
        serviceName: string
    ): aws_ecs.FargateService {
        const fargateService = new aws_ecs.FargateService(this, `${serviceName}-service`, {
            serviceName,
            cluster: cluster,
            securityGroups: [sg],
            taskDefinition,
            desiredCount: 1,
            minHealthyPercent: 100,
            maxHealthyPercent: 200,
            enableExecuteCommand: true,
          });
          
          fargateService.taskDefinition.taskRole.addManagedPolicy(
            aws_iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly')
          );
      

        // autoscaling
        const scaling = fargateService.autoScaleTaskCount({ minCapacity: 1, maxCapacity: 2 });
        scaling.scaleOnCpuUtilization('CpuScaling', { targetUtilizationPercent: 50 });
        scaling.scaleOnMemoryUtilization('MemoryScaling', { targetUtilizationPercent: 50 });
        
        // add to listener
        listener.addTargets(`${serviceName}-target`, {
            protocol: aws_elasticloadbalancingv2.ApplicationProtocol.HTTP,
            targets: [fargateService],
            healthCheck: {
              protocol: aws_elasticloadbalancingv2.Protocol.HTTP,
              path: '/health',
              interval: Duration.seconds(120),
            },
        });

        return fargateService
    }

    /**
     * Creates a Lambda Function to Update ECS Service
     * 
     * The Lambda Function is triggered by an EventBridge Rule that listens for ECR Image Push events.
     * When the Lambda Function is triggered, it updates the ECS Service to use the new task definition.
     * 
     * @param cluster The ECS Cluster.
     * @param fargateService The ECS Service to update.
     * @param taskDefinition The ECS Task Definition to use for the update.
     */
    // TODO: Node JS Function
    private lambda(
        cluster: aws_ecs.ICluster,
        fargateService: aws_ecs.FargateService,
        taskDefinition: aws_ecs.FargateTaskDefinition
    ): aws_lambda.IFunction {
        const lambdaRole = new aws_iam.Role(this, 'LambdaExecutionRole', {
                assumedBy: new aws_iam.ServicePrincipal('lambda.amazonaws.com'),
            });
            lambdaRole.addManagedPolicy(
                aws_iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
            );
            lambdaRole.addManagedPolicy(
                aws_iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonECS_FullAccess')
            );
            lambdaRole.addManagedPolicy(
                aws_iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly')
            );

        // Lambda Function to Update ECS Service
        const lambdaFunction = new aws_lambda.Function(this, 'EcsUpdateLambda', {
            runtime: aws_lambda.Runtime.NODEJS_18_X,
            code: aws_lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
            handler: 'index.handler',
            environment: {
                CLUSTER_NAME: cluster.clusterName,
                SERVICE_NAME: fargateService.serviceName,
                TASK_DEFINITION: taskDefinition.taskDefinitionArn,
            },
            role: lambdaRole,
        });

        return lambdaFunction
    }

    /**
     * Creates an EventBridge Rule to trigger the lambda function when a new image is
     * pushed to the given ECR repository.
     *
     * @param repository The ECR repository to listen to for new image pushes.
     * @param lambdaFunction The lambda function to trigger when a new image is pushed.
     */
    private eventBridge(
        repository: aws_ecr.IRepository,
        lambdaFunction: aws_lambda.IFunction
    ) {
        new aws_events.Rule(this, 'EcrPushEventRule', {
            eventPattern: {
                source: ['aws.ecr'],
                detailType: ['ECR Image Action'],
                detail: {
                    'action-type': ['PUSH'],
                    'repository-name': [repository.repositoryName],
                }
            },
            targets: [new aws_events_targets.LambdaFunction(lambdaFunction)],
        });
  
    }
}