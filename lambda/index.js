const AWS = require('aws-sdk');
const ecs = new AWS.ECS();

// TODO: Use AWS SDK V3 for Lambda
exports.handler = async (event) => {
    const cluster = process.env.CLUSTER_NAME;
    const service = process.env.SERVICE_NAME;
    const taskDefinition = process.env.TASK_DEFINITION;
    
    console.log('Updating service', { cluster, service, taskDefinition });
    
    // Update ECS Service to use the new task definition
    const updateResponse = await ecs.updateService({
        cluster,
        service,
        forceNewDeployment: true,
    }).promise();

    console.log('Service updated', updateResponse);
    return updateResponse;
};
