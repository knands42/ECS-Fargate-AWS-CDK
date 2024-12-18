import { Duration, RemovalPolicy, Stack, StackProps, aws_certificatemanager, aws_ec2, aws_ecr, aws_ecs, aws_ecs_patterns, aws_elasticloadbalancingv2, aws_events, aws_events_targets, aws_iam, aws_lambda, aws_logs, aws_route53, aws_route53_targets } from "aws-cdk-lib";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";
import path = require("path");

interface VpcStackProps extends StackProps {
    natGateways: number
    domainName: string;
    hostedZoneId: string;
    subDomainName: string;
}

export class MainStack extends Stack {
    private ecrTag: string = 'latest'
    private serviceName: string = 'app'
    private containerPort: number = 8030

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
        const { domainName, hostedZoneId, subDomainName } = props;

        const vpc = this.createVpc('custom-vpc');
        const ecsSecurityGroup = this.createEcsSecurityGroup(vpc)
        
        const cert = this.createCertificate(domainName, hostedZoneId);
        const repo = this.createRepository('my-repo');

        const cluster = this.createCluster(this.serviceName, vpc);
        const alb = this.createAlb(this.serviceName, vpc);
        const listener = this.createAlbListener(alb, cert);

        const envVars = {
            PORT: this.containerPort.toString(),
        }
        const taskDefinition = this.taskDefinition(this.serviceName, this.ecrTag, repo, 1024, 4096, this.containerPort, envVars);
        const fargateService = this.createService(cluster, listener, ecsSecurityGroup, taskDefinition, alb, this.serviceName);
        this.createAlbDomain(alb, domainName, hostedZoneId, subDomainName);

        const lambdaFunction = this.lambda(cluster, fargateService.service);
        this.eventBridge(repo, lambdaFunction);
        this.createVpcEndpoints(vpc, ecsSecurityGroup);
    }

    private createVpc(vpcName: string): aws_ec2.Vpc {
        const vpc = new aws_ec2.Vpc(this, 'custom-vpc', {
            vpcName,
            maxAzs: 2,
            subnetConfiguration: [
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

        sg.addIngressRule(
            aws_ec2.Peer.anyIpv4(),
            aws_ec2.Port.allTcp(),
            'Allow traffic from within VPC'
        );
    
        sg.addIngressRule(
            aws_ec2.Peer.anyIpv4(),
            aws_ec2.Port.allTcp(),
            'Allow inbound traffic on container port'
        );
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

        // const autoScalingGroup = new aws_ecs.AsgCapacityProvider(this, 'AsgCapacityProvider', {
        //     autoScalingGroup: new aws_autoscaling.AutoScalingGroup(this, 'AutoScalingGroup', {
        //         vpc: vpc,
        //         machineImage: aws_ecs.EcsOptimizedImage.amazonLinux2(),
        //         instanceType: new aws_ec2.InstanceType('t2.micro'),
        //         spotPrice: '0.01',
        //         minCapacity: 1,
        //         maxCapacity: 10,
        //         desiredCapacity: 2
        //     })
        // });

        // cluster.addAsgCapacityProvider(autoScalingGroup);
    
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
            internetFacing: false,
            vpcSubnets: {
              subnetType: aws_ec2.SubnetType.PRIVATE_ISOLATED
            }
          });

        // remove internet facing 
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
            protocol: aws_elasticloadbalancingv2.ApplicationProtocol.HTTP,
            port: 8030,
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
     * Defaults to 8030.
     * @param envVars Additional environment variables to set in the
     * container.
     */
    private taskDefinition(
        serviceName: string,
        ecrTag: string,
        repository: aws_ecr.IRepository,
        cpu: number = 512, 
        memory: number = 512,
        containerPort: number = 8030,
        envVars: { [key: string]: string } = {}
    ): aws_ecs.FargateTaskDefinition {
        const executionRole = new aws_iam.Role(this, `${serviceName}-execution-role`, {
            assumedBy: new aws_iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            managedPolicies: [
                aws_iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
                aws_iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly')
            ]
        });
    
        const taskDefinition = new aws_ecs.FargateTaskDefinition(this, `${serviceName}-task-def`, {
            family: serviceName,
            memoryLimitMiB: memory,
            cpu: cpu,
            taskRole: executionRole,
            runtimePlatform: {
                operatingSystemFamily: aws_ecs.OperatingSystemFamily.LINUX,
                cpuArchitecture: aws_ecs.CpuArchitecture.ARM64,
            },
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
                logGroup: new aws_logs.LogGroup(this, `${serviceName}-log-group`, {
                    logGroupName: `/ecs/${serviceName}`,
                    retention: aws_logs.RetentionDays.ONE_DAY,
                    removalPolicy: RemovalPolicy.DESTROY
                })    
            }),
            // healthCheck: {
            //     command: ['CMD-SHELL', 'curl --fail http://localhost:8030/health || exit 1'],
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
        loadBalancer: aws_elasticloadbalancingv2.ApplicationLoadBalancer,
        serviceName: string
    ): aws_ecs_patterns.ApplicationLoadBalancedFargateService {
        const fargateService = new aws_ecs_patterns.ApplicationLoadBalancedFargateService(this, `${serviceName}-service`, {
            cluster, 
            cpu: 512, 
            memoryLimitMiB: 512,
            securityGroups: [sg],
            taskDefinition,
            taskSubnets: { subnetType: aws_ec2.SubnetType.PRIVATE_ISOLATED },
            desiredCount: 1,
            loadBalancer: loadBalancer,
        })

        // autoscaling
        const scalableTarget = fargateService.service.autoScaleTaskCount({
            minCapacity: 1,
            maxCapacity: 20,
        });
            
        scalableTarget.scaleOnCpuUtilization('CpuScaling', {
            targetUtilizationPercent: 80,
        });
            
        scalableTarget.scaleOnMemoryUtilization('MemoryScaling', {
            targetUtilizationPercent: 80,
        });

        // add to listener
        listener.addTargets(`${serviceName}-target`, {
            protocol: aws_elasticloadbalancingv2.ApplicationProtocol.HTTP,
            targets: [fargateService.service],
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
    private lambda(
        cluster: aws_ecs.ICluster,
        fargateService: aws_ecs.FargateService,
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
            lambdaRole.addManagedPolicy(
                aws_iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole')
            );
        

        const lambdaSg = new aws_ec2.SecurityGroup(this, 'lambda-sg', {
            vpc: cluster.vpc,
            allowAllOutbound: true,
            description: 'Security group for Lambda function'
        });

        // Lambda Function to Update ECS Service
        const lambdaFunction = new NodejsFunction(this, 'LambdaFunction', {
            entry: path.join(__dirname, '../lambda/index.js'),
            handler: 'handler',
            runtime: aws_lambda.Runtime.NODEJS_22_X,
            role: lambdaRole,
            environment: {
              CLUSTER_NAME: cluster.clusterName,
              SERVICE_NAME: fargateService.serviceName,
            },
            vpc: cluster.vpc,
            vpcSubnets: { subnetType: aws_ec2.SubnetType.PRIVATE_ISOLATED },
            securityGroups: [lambdaSg],
            bundling: {
              externalModules: ['@aws-sdk/client-ecs'], // Avoid bundling AWS SDK to reduce size
            },
      
        })

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

    private createVpcEndpoints(vpc: aws_ec2.IVpc, sg: aws_ec2.SecurityGroup) {
        vpc.addInterfaceEndpoint('ecr-docker', {
            service: aws_ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
            privateDnsEnabled: true,
            subnets: {
                subnetType: aws_ec2.SubnetType.PRIVATE_ISOLATED
            },
        });

        vpc.addInterfaceEndpoint('ecr-api', {
            service: aws_ec2.InterfaceVpcEndpointAwsService.ECR,
            privateDnsEnabled: true,
            subnets: {
                subnetType: aws_ec2.SubnetType.PRIVATE_ISOLATED
            },
            securityGroups: [sg],
        });

        vpc.addInterfaceEndpoint('ecr-ecs', {
            service: aws_ec2.InterfaceVpcEndpointAwsService.ECS,
            privateDnsEnabled: true,
            subnets: {
                subnetType: aws_ec2.SubnetType.PRIVATE_ISOLATED
            },
            securityGroups: [sg],
        });

        vpc.addGatewayEndpoint('s3-endpoint', {
            service: aws_ec2.GatewayVpcEndpointAwsService.S3,
            subnets: [{
                subnetType: aws_ec2.SubnetType.PRIVATE_ISOLATED
            }],
        });

        vpc.addInterfaceEndpoint('ecr-sts', {
            service: aws_ec2.InterfaceVpcEndpointAwsService.STS,
            privateDnsEnabled: true,
            subnets: {
                subnetType: aws_ec2.SubnetType.PRIVATE_ISOLATED
            },
            securityGroups: [sg],
        });

        vpc.addInterfaceEndpoint('logs', {
            service: aws_ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
            privateDnsEnabled: true,
            subnets: {
                subnetType: aws_ec2.SubnetType.PRIVATE_ISOLATED
            },
            securityGroups: [sg],
        });

        vpc.addInterfaceEndpoint('events', {
            service: aws_ec2.InterfaceVpcEndpointAwsService.EVENTBRIDGE,
            privateDnsEnabled: true,
            subnets: {
                subnetType: aws_ec2.SubnetType.PRIVATE_ISOLATED
            },
            securityGroups: [sg],
        });
    
        vpc.addInterfaceEndpoint('lambda', {
            service: aws_ec2.InterfaceVpcEndpointAwsService.LAMBDA,
            privateDnsEnabled: true,
            subnets: {
                subnetType: aws_ec2.SubnetType.PRIVATE_ISOLATED
            },
            securityGroups: [sg],
        });

        vpc.addInterfaceEndpoint('secretmanager', {
            service: aws_ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
            privateDnsEnabled: true,
            subnets: {
                subnetType: aws_ec2.SubnetType.PRIVATE_ISOLATED
            },
            securityGroups: [sg],
        });
    }
}