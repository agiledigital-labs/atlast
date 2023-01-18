import JiraAPI from 'jira-client';
import * as TE from 'fp-ts/TaskEither';
import * as RTE from 'fp-ts/ReaderTaskEither';
import * as E from 'fp-ts/Either';
import * as T from 'io-ts';
import { identity, pipe } from 'fp-ts/function';
import { chainableError } from './error-service';

export type ClientEnv = {
  readonly client: JiraAPI;
};

export const JiraErrorResponse = T.type({
  errorMessages: T.readonlyArray(T.string),
});

export type JiraErrorResponse = T.TypeOf<typeof JiraErrorResponse>;

/**
 * Configuration required to create a Jira client.
 */
export type JiraConfiguration = {
  /** The identifier of the client application in Okta. */
  readonly username: string;
  /** JSON encoded private key for the application. */
  readonly password: string;
};

export const jiraClient = (jiraConfiguration: JiraConfiguration) =>
  new JiraAPI({
    protocol: 'https',
    host: 'agiledigital.atlassian.net',
    username: jiraConfiguration.username,
    password: jiraConfiguration.password,
    apiVersion: '3',
    strictSSL: true,
  });

export const makeRequest = (
  f: (
    // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
    jiraClient: JiraAPI
  ) => Promise<JiraAPI.JsonResponse>
): RTE.ReaderTaskEither<
  ClientEnv,
  Error | JiraErrorResponse,
  JiraAPI.JsonResponse
> =>
  pipe(
    // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
    RTE.asks<ClientEnv, JiraAPI>((env) => env.client),
    // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
    RTE.chainTaskEitherKW((client) =>
      TE.tryCatch(
        // eslint-disable-next-line functional/functional-parameters
        () => f(client),
        (error: unknown) => {
          const maybeJson =
            error instanceof Error
              ? E.tryCatch(
                  // eslint-disable-next-line functional/functional-parameters, @typescript-eslint/consistent-type-assertions
                  () => JSON.parse(error.message) as unknown,
                  // eslint-disable-next-line functional/functional-parameters
                  () => error
                )
              : E.left(new Error(JSON.stringify(error)));
          return pipe(
            maybeJson,
            E.chainW((message) => JiraErrorResponse.decode(message)),
            E.foldW(
              // eslint-disable-next-line functional/functional-parameters, @typescript-eslint/prefer-readonly-parameter-types
              () => {
                // Ignore parsing errors - we'll just assume that we didn't get an actionable error if it can't be decoded.
                return new Error(
                  'Failed when invoking Jira API.',
                  chainableError(error)
                );
              },
              identity
            )
          );
        }
      )
    )
  );
