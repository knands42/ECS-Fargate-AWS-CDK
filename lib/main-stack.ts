import { Duration, Stack, StackProps, aws_certificatemanager, aws_ec2, aws_ecr, aws_ecs, aws_elasticloadbalancingv2, aws_events, aws_events_targets, aws_iam, aws_logs, aws_route53, aws_route53_targets } from "aws-cdk-lib";
import { Construct } from "constructs";

interface VpcStackProps extends StackProps {
    natGateways: number
    domainName: string;
    hostedZoneId: string;
    subDomainName: string;
}

export class MainStack extends Stack {
    public vpc: aws_ec2.IVpc
    public sg: aws_ec2.ISecurityGroup

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
        const fargateService = this.createService(cluster, listener, ecsSecurityGroup, repo, 256, 512);
        this.createAlbDomain(alb, domainName, hostedZoneId, subDomainName);
        this.evenbridge(repo, cluster, fargateService);
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

    createCluster(name: string, vpc: aws_ec2.IVpc) {
        const cluster = new aws_ecs.Cluster(this, `${name}-cluster`, {
            clusterName: name,
            vpc: vpc,
            containerInsights: true,
            enableFargateCapacityProviders: true,
        });
    
        return cluster;
    }

    createAlb(name: string, vpc: aws_ec2.IVpc) {
        const loadBalancer = new aws_elasticloadbalancingv2.ApplicationLoadBalancer(this, 'ALB', {
            loadBalancerName: name,
            vpc: vpc,
            internetFacing: true,
          });

        return loadBalancer
    }
    
    createAlbListener(alb: aws_elasticloadbalancingv2.ApplicationLoadBalancer, certificate: aws_certificatemanager.ICertificate) {
        const listener = alb.addListener(`HttpsListener`, {
          port: 443,
          certificates: [certificate],
        });
    
        return listener;
    }

    createAlbDomain(alb: aws_elasticloadbalancingv2.ApplicationLoadBalancer, domainName: string, zoneId: string, subDomain: string) {
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

    createService(
        cluster: aws_ecs.ICluster,
        listener: aws_elasticloadbalancingv2.ApplicationListener, 
        sg: aws_ec2.ISecurityGroup, 
        repository: aws_ecr.IRepository,
        cpu: number = 256, 
        memory: number = 512,
    ) {
        const ecrTag = 'latest'
        const serviceName = 'app'
        const containerPort = 8080
        const envVars = {
            PORT: containerPort.toString(),
        }

        // task definition
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
        
        // service
        const service = new aws_ecs.FargateService(this, `${serviceName}-service`, {
            serviceName,
            cluster: cluster,
            securityGroups: [sg],
            taskDefinition,
            desiredCount: 1,
            minHealthyPercent: 100,
            maxHealthyPercent: 200,
            enableExecuteCommand: true,
          });
          
          service.taskDefinition.taskRole.addManagedPolicy(
            aws_iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly')
          );
      

        // autoscaling
        const scaling = service.autoScaleTaskCount({ minCapacity: 1, maxCapacity: 2 });
        scaling.scaleOnCpuUtilization('CpuScaling', { targetUtilizationPercent: 50 });
        scaling.scaleOnMemoryUtilization('MemoryScaling', { targetUtilizationPercent: 50 });
        
        // add to listener
        listener.addTargets(`${serviceName}-target`, {
            protocol: aws_elasticloadbalancingv2.ApplicationProtocol.HTTP,
            targets: [service],
            healthCheck: {
              protocol: aws_elasticloadbalancingv2.Protocol.HTTP,
              path: '/health',
              interval: Duration.seconds(120),
            },
        });

        return service
    }

    private evenbridge(repository: aws_ecr.IRepository, cluster: aws_ecs.ICluster, service: aws_ecs.FargateService) {
        // EventBridge Rule for ECR Image Push
        const rule = new aws_events.Rule(this, 'EcrImagePushRule', {
            eventPattern: {
                source: ['aws.ecr'],
                detailType: ['ECR Image Action'],
                detail: {
                    'action-type': ['PUSH'],
                    'repository-name': [repository.repositoryName],
                },
            },
        });
    
        // EventBridge Target: ECS Service Deployment
        rule.addTarget(new aws_events_targets.EcsTask({
            cluster,
            taskDefinition: service.taskDefinition,
            role: service.taskDefinition.taskRole,
            containerOverrides: [{
                containerName: 'app',
                environment: [
                    {
                        name: 'IMAGE_URI',
                        value: `${repository.repositoryUri}:latest`,
                    },
                ],
            }],
        }));
    }
}