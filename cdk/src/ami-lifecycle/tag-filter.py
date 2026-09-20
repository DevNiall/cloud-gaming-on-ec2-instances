"""
Lambda function to filter EC2 state change events based on SnapAndDelete tag.
Only instances with SnapAndDelete=true trigger the Step Functions workflow.
"""
import json
import boto3
import os

ec2_client = boto3.client('ec2')
sfn_client = boto3.client('stepfunctions')

STATE_MACHINE_ARN = os.environ['STATE_MACHINE_ARN']


def lambda_handler(event, context):
    """
    Filter EventBridge EC2 state change events by SnapAndDelete tag.
    Starts Step Functions execution if tag check passes.
    """
    print(f"Received event: {json.dumps(event)}")
    
    # Extract instance ID from EventBridge event
    instance_id = event['detail']['instance-id']
    state = event['detail']['state']
    
    print(f"Instance {instance_id} changed to state: {state}")
    
    # Only process stopped instances
    if state != 'stopped':
        print(f"Ignoring non-stopped state: {state}")
        return {'statusCode': 200, 'body': 'Ignored non-stopped state'}
    
    # Check for SnapAndDelete tag
    try:
        response = ec2_client.describe_instances(InstanceIds=[instance_id])
        instances = response['Reservations'][0]['Instances']
        
        if not instances:
            print(f"Instance {instance_id} not found")
            return {'statusCode': 404, 'body': 'Instance not found'}
        
        instance = instances[0]
        tags = {tag['Key']: tag['Value'] for tag in instance.get('Tags', [])}
        
        snap_and_delete = tags.get('SnapAndDelete', '').lower()
        
        if snap_and_delete != 'true':
            print(f"Instance {instance_id} does not have SnapAndDelete=true tag. Current value: {snap_and_delete}")
            return {'statusCode': 200, 'body': 'Tag check failed'}
        
        print(f"Instance {instance_id} has SnapAndDelete=true, starting Step Functions execution")
        
        # Start Step Functions execution with idempotent name
        execution_name = f"ami-creation-{instance_id}-{event['time'].replace(':', '-').replace('.', '-')}"
        
        # Prepare input for Step Functions
        sfn_input = {
            'instanceId': instance_id,
            'instanceName': tags.get('Name', instance_id),
            'spotRequestId': instance.get('SpotInstanceRequestId'),
            'eventTime': event['time']
        }
        
        response = sfn_client.start_execution(
            stateMachineArn=STATE_MACHINE_ARN,
            name=execution_name,
            input=json.dumps(sfn_input)
        )
        
        print(f"Started Step Functions execution: {response['executionArn']}")
        
        return {
            'statusCode': 200,
            'body': json.dumps({
                'message': 'Step Functions execution started',
                'executionArn': response['executionArn']
            })
        }
        
    except Exception as e:
        print(f"Error processing instance {instance_id}: {str(e)}")
        raise
