const { ECSClient, UpdateServiceCommand } = require('@aws-sdk/client-ecs');

exports.handler = async (event) => {
  const ecsClient = new ECSClient({ region: process.env.AWS_REGION });

  const cluster = process.env.CLUSTER_NAME;
  const service = process.env.SERVICE_NAME;

  console.log('ECR Event:', JSON.stringify(event, null, 2));

  try {
    console.log('Updating ECS service...');
    const updateServiceCommand = new UpdateServiceCommand({
      cluster,
      service,
      forceNewDeployment: true,
    });

    const response = await ecsClient.send(updateServiceCommand);
    console.log('ECS service updated successfully:', JSON.stringify(response, null, 2));

    return response;
  } catch (error) {
    console.error('Error updating ECS service:', error);
    throw new Error(`ECS service update failed: ${error.message}`);
  }
};
