/**
 * AWS Amplify configuration.
 *
 * Values are read from environment variables so that the same build can target
 * different Cognito pools without code changes.  Set these in a `.env.local`
 * file for local development or as repository/environment secrets in CI.
 *
 * Required environment variables:
 *   NEXT_PUBLIC_AWS_REGION          – e.g. us-east-1
 *   NEXT_PUBLIC_COGNITO_USER_POOL_ID – e.g. us-east-1_XXXXXXXXX
 *   NEXT_PUBLIC_COGNITO_CLIENT_ID    – App client ID (no secret)
 *   NEXT_PUBLIC_API_BASE_URL         – API Gateway invoke URL
 */

import { Amplify } from 'aws-amplify';

export function configureAmplify() {
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID ?? '',
        userPoolClientId: process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID ?? '',
        loginWith: {
          email: true,
        },
      },
    },
  });
}

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? '';
