/* tslint:disable:no-submodule-imports quotemark no-unused-expression */
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';

export class AmiLifecycleStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // SNS Topic for failure notifications
    const failureTopic = new sns.Topic(this, 'AmiCreationFailureTopic', {
      displayName: 'AMI Creation Failure Notifications',
      topicName: 'gaming-ami-creation-failures',
    });

    // SQS Dead Letter Queue for orphaned volume cleanup retries
    const volumeCleanupDlq = new sqs.Queue(this, 'VolumeCleanupDLQ', {
      queueName: 'gaming-volume-cleanup-dlq',
      retentionPeriod: cdk.Duration.days(14),
    });

    // Step Functions execution role
    const stateMachineRole = new iam.Role(this, 'StateMachineRole', {
      assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
      description: 'Role for AMI Lifecycle Step Functions',
    });

    stateMachineRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:CreateImage',
        'ec2:DescribeImages',
        'ec2:CreateTags',
        'ec2:DeregisterImage',
        'ec2:DeleteSnapshot',
        'ec2:DescribeSnapshots',
        'ec2:CancelSpotInstanceRequests',
        'ec2:TerminateInstances',
        'ec2:DescribeInstances',
        'ec2:DescribeVolumes',
        'ec2:DeleteVolume',
      ],
      resources: ['*'],
    }));

    stateMachineRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['sns:Publish'],
      resources: [failureTopic.topicArn],
    }));

    stateMachineRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['sqs:SendMessage'],
      resources: [volumeCleanupDlq.queueArn],
    }));

    // Step Functions state machine definition
    const stateMachine = this.createStateMachine(stateMachineRole, failureTopic.topicArn);

    // Lambda function for tag-based filtering
    const tagFilterFunction = new lambda.Function(this, 'TagFilterFunction', {
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'tag-filter.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../src/ami-lifecycle')),
      timeout: cdk.Duration.seconds(30),
      environment: {
        STATE_MACHINE_ARN: stateMachine.stateMachineArn,
      },
    });

    tagFilterFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ec2:DescribeInstances'],
      resources: ['*'],
    }));

    tagFilterFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['states:StartExecution'],
      resources: [stateMachine.stateMachineArn],
    }));

    // EventBridge rule for EC2 instance state changes
    const stateChangeRule = new events.Rule(this, 'InstanceStateChangeRule', {
      eventPattern: {
        source: ['aws.ec2'],
        detailType: ['EC2 Instance State-change Notification'],
        detail: {
          state: ['stopped'],
        },
      },
      description: 'Trigger AMI creation workflow when instances are stopped',
    });

    stateChangeRule.addTarget(new targets.LambdaFunction(tagFilterFunction));

    // CloudWatch Log Group for Step Functions
    const logGroup = new logs.LogGroup(this, 'StateMachineLogGroup', {
      logGroupName: '/aws/stepfunctions/gaming-ami-lifecycle',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Outputs
    new cdk.CfnOutput(this, 'StateMachineArn', {
      value: stateMachine.stateMachineArn,
      description: 'ARN of the AMI Lifecycle Step Functions',
    });

    new cdk.CfnOutput(this, 'FailureTopicArn', {
      value: failureTopic.topicArn,
      description: 'SNS Topic for AMI creation failure notifications',
    });

    new cdk.CfnOutput(this, 'VolumeCleanupDlqUrl', {
      value: volumeCleanupDlq.queueUrl,
      description: 'DLQ for failed volume cleanup operations',
    });
  }

  private createStateMachine(role: iam.Role, failureTopicArn: string): sfn.StateMachine {
    // State 1: Create AMI from stopped instance
    const createImage = new tasks.CallAwsService(this, 'CreateImage', {
      service: 'ec2',
      action: 'createImage',
      parameters: {
        InstanceId: sfn.JsonPath.stringAt('$.instanceId'),
        Name: sfn.JsonPath.format('gaming-{}-{}', sfn.JsonPath.stringAt('$.instanceName'), sfn.JsonPath.stringAt('$$.Execution.StartTime')),
        Description: sfn.JsonPath.format('AMI created from {} at {}', sfn.JsonPath.stringAt('$.instanceId'), sfn.JsonPath.stringAt('$.eventTime')),
        NoReboot: true,
        TagSpecifications: [{
          ResourceType: 'image',
          Tags: [
            { Key: 'SnapAndDelete', Value: 'true' },
            { Key: 'SourceInstance', Value: sfn.JsonPath.stringAt('$.instanceId') },
            { Key: 'CreatedBy', Value: 'AmiLifecycleWorkflow' },
          ],
        }],
      },
      iamResources: ['*'],
      resultPath: '$.createImageResult',
    });

    createImage.addRetry({
      errors: ['States.ALL'],
      interval: cdk.Duration.seconds(30),
      maxAttempts: 3,
      backoffRate: 2,
    });

    createImage.addCatch(this.createFailureNotification(failureTopicArn, 'CreateImage'), {
      resultPath: '$.error',
    });

    // State 2: Wait for AMI to become available
    const waitForImage = new sfn.Wait(this, 'WaitForImage', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    const checkImageStatus = new tasks.CallAwsService(this, 'CheckImageStatus', {
      service: 'ec2',
      action: 'describeImages',
      parameters: {
        ImageIds: [sfn.JsonPath.stringAt('$.createImageResult.ImageId')],
      },
      iamResources: ['*'],
      resultPath: '$.imageStatus',
    });

    const isImageAvailable = new sfn.Choice(this, 'IsImageAvailable')
      .when(
        sfn.Condition.stringEquals('$.imageStatus.Images[0].State', 'available'),
        new sfn.Pass(this, 'ImageReady')
      )
      .otherwise(waitForImage);

    waitForImage.next(checkImageStatus);
    checkImageStatus.next(isImageAvailable);

    // State 3: Tag AMI with instance name
    const tagAmi = new tasks.CallAwsService(this, 'TagAMI', {
      service: 'ec2',
      action: 'createTags',
      parameters: {
        Resources: [sfn.JsonPath.stringAt('$.createImageResult.ImageId')],
        Tags: [
          { Key: 'Name', Value: sfn.JsonPath.stringAt('$.instanceName') },
        ],
      },
      iamResources: ['*'],
      resultPath: '$.tagResult',
    });

    // State 4: Deregister old AMIs (keep latest only)
    const describeOldAmis = new tasks.CallAwsService(this, 'DescribeOldAMIs', {
      service: 'ec2',
      action: 'describeImages',
      parameters: {
        Owners: ['self'],
        Filters: [
          { Name: 'tag:SnapAndDelete', Values: ['true'] },
          { Name: 'tag:SourceInstance', Values: [sfn.JsonPath.stringAt('$.instanceId')] },
        ],
      },
      iamResources: ['*'],
      resultPath: '$.oldAmis',
    });

    const deregisterOldAmis = new tasks.CallAwsService(this, 'DeregisterOldAMIs', {
      service: 'ec2',
      action: 'deregisterImage',
      parameters: {
        ImageId: sfn.JsonPath.stringAt('$.oldAmi.ImageId'),
      },
      iamResources: ['*'],
      resultPath: sfn.JsonPath.DISCARD,
    });

    const deleteOldSnapshots = new tasks.CallAwsService(this, 'DeleteOldSnapshots', {
      service: 'ec2',
      action: 'deleteSnapshot',
      parameters: {
        SnapshotId: sfn.JsonPath.stringAt('$.snapshot.SnapshotId'),
      },
      iamResources: ['*'],
      resultPath: sfn.JsonPath.DISCARD,
    });

    // State 5: Cancel spot instance request to prevent restart
    const cancelSpotRequest = new tasks.CallAwsService(this, 'CancelSpotRequest', {
      service: 'ec2',
      action: 'cancelSpotInstanceRequests',
      parameters: {
        SpotInstanceRequestIds: [sfn.JsonPath.stringAt('$.spotRequestId')],
      },
      iamResources: ['*'],
      resultPath: '$.cancelSpotResult',
    });

    cancelSpotRequest.addRetry({
      errors: ['States.ALL'],
      interval: cdk.Duration.seconds(10),
      maxAttempts: 3,
      backoffRate: 1.5,
    });

    // Continue even if spot request cancellation fails (might not be a spot instance)
    cancelSpotRequest.addCatch(new sfn.Pass(this, 'SpotCancelFailed'), {
      resultPath: sfn.JsonPath.DISCARD,
    });

    // State 6: Terminate instance
    const terminateInstance = new tasks.CallAwsService(this, 'TerminateInstance', {
      service: 'ec2',
      action: 'terminateInstances',
      parameters: {
        InstanceIds: [sfn.JsonPath.stringAt('$.instanceId')],
      },
      iamResources: ['*'],
      resultPath: '$.terminateResult',
    });

    terminateInstance.addRetry({
      errors: ['States.ALL'],
      interval: cdk.Duration.seconds(15),
      maxAttempts: 3,
      backoffRate: 2,
    });

    terminateInstance.addCatch(this.createFailureNotification(failureTopicArn, 'TerminateInstance'), {
      resultPath: '$.error',
    });

    // State 7: Wait for instance termination
    const waitForTermination = new sfn.Wait(this, 'WaitForTermination', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(20)),
    });

    const checkTerminationStatus = new tasks.CallAwsService(this, 'CheckTerminationStatus', {
      service: 'ec2',
      action: 'describeInstances',
      parameters: {
        InstanceIds: [sfn.JsonPath.stringAt('$.instanceId')],
      },
      iamResources: ['*'],
      resultPath: '$.terminationStatus',
    });

    const isTerminated = new sfn.Choice(this, 'IsTerminated')
      .when(
        sfn.Condition.stringEquals('$.terminationStatus.Reservations[0].Instances[0].State.Name', 'terminated'),
        new sfn.Pass(this, 'InstanceTerminated')
      )
      .otherwise(waitForTermination);

    waitForTermination.next(checkTerminationStatus);
    checkTerminationStatus.next(isTerminated);

    // State 8: Delete orphaned volumes
    const describeVolumes = new tasks.CallAwsService(this, 'DescribeOrphanedVolumes', {
      service: 'ec2',
      action: 'describeVolumes',
      parameters: {
        Filters: [
          { Name: 'status', Values: ['available'] },
          { Name: 'tag:SnapAndDelete', Values: ['true'] },
        ],
      },
      iamResources: ['*'],
      resultPath: '$.volumes',
    });

    const deleteVolume = new tasks.CallAwsService(this, 'DeleteVolume', {
      service: 'ec2',
      action: 'deleteVolume',
      parameters: {
        VolumeId: sfn.JsonPath.stringAt('$.volume.VolumeId'),
      },
      iamResources: ['*'],
      resultPath: sfn.JsonPath.DISCARD,
    });

    deleteVolume.addRetry({
      errors: ['States.ALL'],
      interval: cdk.Duration.minutes(1),
      maxAttempts: 5,
      backoffRate: 2,
    });

    const success = new sfn.Succeed(this, 'Success');

    // Wire up the state machine
    const definition = createImage
      .next(waitForImage)
      .next(new sfn.Pass(this, 'ImageAvailable'))
      .next(tagAmi)
      .next(describeOldAmis)
      .next(cancelSpotRequest)
      .next(terminateInstance)
      .next(waitForTermination)
      .next(new sfn.Pass(this, 'Terminated'))
      .next(describeVolumes)
      .next(success);

    const stateMachine = new sfn.StateMachine(this, 'AmiLifecycleStateMachine', {
      stateMachineName: 'gaming-ami-lifecycle',
      definition,
      role,
      stateMachineType: sfn.StateMachineType.STANDARD,
      timeout: cdk.Duration.hours(2),
      tracingEnabled: true,
    });

    return stateMachine;
  }

  private createFailureNotification(topicArn: string, stageName: string): sfn.IChainable {
    return new tasks.SnsPublish(this, `Notify${stageName}Failure`, {
      topic: sns.Topic.fromTopicArn(this, `${stageName}FailureTopic`, topicArn),
      message: sfn.TaskInput.fromObject({
        stage: stageName,
        error: sfn.JsonPath.stringAt('$.error'),
        instanceId: sfn.JsonPath.stringAt('$.instanceId'),
        executionId: sfn.JsonPath.stringAt('$$.Execution.Id'),
      }),
      subject: `AMI Lifecycle Failed at ${stageName}`,
    }).next(new sfn.Fail(this, `${stageName}Failed`, {
      cause: 'AMI lifecycle workflow failed',
      error: stageName,
    }));
  }
}
