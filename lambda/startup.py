import os
import boto3
import json
import requests

from nacl.signing import VerifyKey
from nacl.exceptions import BadSignatureError
from dotenv import load_dotenv
load_dotenv()

PUBLIC_KEY = os.environ.get('DISCORD_API_KEY') # found on Discord Application -> General Information page
PING_PONG = {'statusCode': 200, 'body': json.dumps({'type': 1})}
RESPONSE_TYPES =  {
                    "PONG": 1,
                    "ACK_NO_SOURCE": 2,
                    "MESSAGE_NO_SOURCE": 3,
                    "MESSAGE_WITH_SOURCE": 4,
                    "ACK_WITH_SOURCE": 5
                  }

DEFAULT_REGION = 'ap-southeast-2'
DEFAULT_CLUSTER = 'ValheimCDKCluster'
DEFAULT_SERVICE = 'ValheimServerService'

REGION = os.environ.get('REGION', DEFAULT_REGION)
CLUSTER = os.environ.get('CLUSTER', DEFAULT_CLUSTER)
SERVICE = os.environ.get('SERVICE', DEFAULT_SERVICE)

if REGION is None or CLUSTER is None or SERVICE is None or PUBLIC_KEY is None:
    raise ValueError("Missing environment variables")

def ping_pong(body):
    jsonbody = json.loads(body)
    if jsonbody["type"] == 1:
        return True

def verify_signature(event):
    body = event['body']
    signature = event['headers']['x-signature-ed25519']
    timestamp  = event['headers']['x-signature-timestamp']

    verify_key = VerifyKey(bytes.fromhex(PUBLIC_KEY))
    verify_key.verify(f'{timestamp}{body}'.encode(), bytes.fromhex(signature)) # raises an error if unequal


def lambda_handler(event, context):
    try:
        verify_signature(event)
    except Exception as e:
        raise Exception(f"[UNAUTHORISED] Invalid Request Signature: {e}")

    body = event['body']
    if ping_pong(body):
        return PING_PONG

    """Updates the desired count for a service."""

    ecs = boto3.client('ecs', region_name=REGION)
    response = ecs.describe_services(
        cluster=CLUSTER,
        services=[SERVICE],
    )

    jsonbody = json.loads(body)

    command = jsonbody['data']['options'][0]['value']
    interaction_id = jsonbody['id']
    interaction_token = jsonbody['token']

    desired = response["services"][0]["desiredCount"]

    if command == 'start':
        if desired == 0:
            ecs.update_service(
                cluster=CLUSTER,
                service=SERVICE,
                desiredCount=1,
            )
            message = "Starting Valheim Server"
            print("Updated desiredCount to 1")
        else:
            message = "Valheim Server already running - try again later."
            print("desiredCount already at 1")
    elif command == 'stop':
        if desired == 1:
            ecs.update_service(
                cluster=CLUSTER,
                service=SERVICE,
                desiredCount=0,
            )
            message = "Stopping Valheim Server"
            print("Updated desiredCount to 0")
        else:
            message = "Valheim Server already stopped - try again later."
            print("desiredCount already at 0")
    else:
            message = "Beep boop. Invalid command - try 'start' or 'stop'."

    url = f"https://discord.com/api/v8/interactions/{interaction_id}/{interaction_token}/callback"
    payload = {
        "type": 4,
        "data": {
            "content": message
        }
    }

    r = requests.post(url, json=payload)

    return {
        "statusCode": 200,
        'body': json.dumps({
            "type": RESPONSE_TYPES['MESSAGE_WITH_SOURCE'],
            "data": {
                "tts": False,
                "content": message,
                "embeds": [],
                "allowed_mentions": []
            }
        })
    }