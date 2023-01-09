import * as TE from 'fp-ts/lib/TaskEither';
import * as E from 'fp-ts/lib/Either';
import * as O from 'fp-ts/lib/Option';
import * as T from 'io-ts';
import { PathReporter } from 'io-ts/lib/PathReporter';

import JiraAPI from 'jira-client';
import { pipe } from 'fp-ts/lib/function';
import { chainableError } from './error-service';
import { JiraErrorResponse, makeRequest } from './client-service';

const JiraUser = T.readonly(
  T.type({
    displayName: T.string,
    self: T.string,
    accountId: T.string,
  })
);

const JiraProject = T.readonly(
  T.type({
    self: T.string,
    name: T.string,
    id: T.string,
    lead: JiraUser,
    projectTypeKey: T.string,
    key: T.string,
  })
);

type JiraProject = T.TypeOf<typeof JiraProject>;

const JiraGroup = T.readonly(
  T.type({
    groupId: T.string,
    displayName: T.string,
  })
);

type JiraGroup = T.TypeOf<typeof JiraGroup>;

const JiraProjectRole = T.readonly(
  T.type({
    id: T.number,
    name: T.string,
    self: T.string,
  })
);

const JiraProjectRoles = T.readonlyArray(JiraProjectRole);

type JiraProjectRoles = T.TypeOf<typeof JiraProjectRoles>;

const JiraActorGroupRole = T.readonly(
  T.type({
    actorGroup: JiraGroup,
  })
);

type JiraActorGroupRole = T.TypeOf<typeof JiraActorGroupRole>;

const JiraProjectRoleDetails = T.readonly(
  T.intersection([
    JiraProjectRole,
    T.readonly(
      T.type({
        actors: T.readonlyArray(
          T.readonly(
            T.intersection([
              T.type({
                id: T.number,
                displayName: T.string,
              }),
              T.union([
                JiraActorGroupRole,
                T.type({
                  actorUser: T.readonly(
                    T.type({
                      accountId: T.string,
                    })
                  ),
                }),
              ]),
            ])
          )
        ),
      })
    ),
  ])
);

type JiraProjectRoleDetails = T.TypeOf<typeof JiraProjectRoleDetails>;

type ProjectGroupRole = {
  readonly role: string;
  readonly groups: readonly JiraGroup[];
};

export type Project = {
  readonly id: string;
  readonly key: string;
  readonly lead: {
    readonly displayName: string;
  };
  readonly groupRoles: readonly ProjectGroupRole[];
};

// eslint-disable-next-line functional/no-class
class ProjectNotFound extends Error {
  constructor(
    override readonly message: string,
    readonly projectKe: string,
    // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
    options: ErrorOptions
  ) {
    // eslint-disable-next-line functional/no-expression-statement
    super(message, options);
  }
}

/**
 * Maps the left side of a validation error into a human readable form. Leaves the right as is.
 *
 * @param validation the validation whose left should be mapped.
 * @returns the mapped validation.
 */
const mapValidationError = <T>(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  validation: T.Validation<T>
): E.Either<readonly string[], T> =>
  E.isLeft(validation) ? E.left(PathReporter.report(validation)) : validation;

/**
 * Decodes a value using the supplied decoder and maps errors to a readable form.
 *
 * @param name name of the decoded type for reporting.
 * @param input value to be decoded.
 * @param decoder decoder to apply to the value.
 * @returns either a human readable error or the decoded value.
 */
const decode =
  <I, O>(
    message: (errors: readonly string[]) => string,
    decoder: T.Decoder<I, O>
  ) =>
  (input: I): E.Either<Error, O> =>
    pipe(
      input,
      decoder.decode,
      mapValidationError,
      E.mapLeft((errors) => new AggregateError(errors, message(errors)))
    );

// eslint-disable-next-line functional/no-class
export class JiraProjectService {
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  constructor(private readonly client: JiraAPI) {}

  readonly getProject = (
    projectKey: string
  ): TE.TaskEither<Error | JiraErrorResponse, O.Option<Project>> => {
    return pipe(
      // eslint-disable-next-line functional/no-this-expression
      this.client,
      // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
      makeRequest((client) => client.getProject(projectKey)),
      TE.chainEitherKW(
        decode(
          // eslint-disable-next-line functional/functional-parameters
          () => `Failed to decode project response for [${projectKey}].`,
          JiraProject.asDecoder()
        )
      ),
      // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
      TE.mapLeft((error) =>
        JiraErrorResponse.is(error)
          ? error.errorMessages.some((errorMessage) =>
              errorMessage.startsWith('No project could be found with')
            )
            ? new ProjectNotFound(
                `Project [${projectKey}] does not exist.`,
                projectKey,
                chainableError(error)
              )
            : new Error(
                `Unknown error while retrieving project [${projectKey}].`,
                chainableError(error)
              )
          : error
      ),
      TE.chain((project) => {
        return pipe(
          // eslint-disable-next-line functional/no-this-expression
          this.getProjectRoles(project.key),
          TE.map((roles) => {
            const groupRoles: readonly ProjectGroupRole[] = roles
              .filter((role) =>
                role.actors.some((actor) => JiraActorGroupRole.is(actor))
              )
              .map((role) => {
                const actorGroupRoles: readonly JiraActorGroupRole[] =
                  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
                  role.actors.filter((actor) =>
                    JiraActorGroupRole.is(actor)
                  ) as readonly JiraActorGroupRole[];

                return {
                  role: role.name,
                  groups: actorGroupRoles.map((group) => group.actorGroup),
                };
              });

            const augmentProject: Project = {
              ...project,
              groupRoles,
            };

            return augmentProject;
          })
        );
      }),
      TE.map(O.some),
      // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
      TE.orElseW((error) => {
        return error instanceof ProjectNotFound
          ? TE.right(O.none)
          : TE.left(error);
      })
    );
  };

  readonly getProjectRoleDetails = (projectKey: string, roleId: number) => {
    const path = `/project/${projectKey}/role/${roleId}`;
    return pipe(
      // eslint-disable-next-line functional/no-this-expression
      this.client,
      // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
      makeRequest((client) => client.genericGet(path)),
      TE.chainEitherKW(
        decode(
          // eslint-disable-next-line functional/functional-parameters
          () =>
            `Failed to decode project role response for project [${projectKey}] and role [${roleId}] at path [${path}]`,
          JiraProjectRoleDetails.asDecoder()
        )
      )
    );
  };

  readonly getProjectRoles = (projectKey: string) => {
    const path = `/project/${projectKey}/roledetails`;
    return pipe(
      // eslint-disable-next-line functional/no-this-expression
      this.client,
      // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
      makeRequest((client) => client.genericGet(path)),
      TE.chainEitherKW(
        decode(
          // eslint-disable-next-line functional/functional-parameters
          () =>
            `Failed to decode project roles response for [${projectKey}] at path [${path}].`,
          JiraProjectRoles.asDecoder()
        )
      ),
      TE.chain(
        TE.traverseSeqArray((role) =>
          // eslint-disable-next-line functional/no-this-expression
          this.getProjectRoleDetails(projectKey, role.id)
        )
      )
    );
  };

  readonly projectGroups = (clientCode: string): readonly string[] =>
    ['developers', 'business', 'administrators'].map((suffix) =>
      `${clientCode}-${suffix}`.toLowerCase()
    );

  readonly rolesForGroup = (group: string): readonly string[] =>
    group.endsWith('-developers')
      ? ['Team Member']
      : group.endsWith('-business')
      ? ['Business Owner']
      : group.endsWith('-administrators')
      ? ['Administrators']
      : [];
}

export type ProjectService = {
  readonly getProject: JiraProjectService['getProject'];
  readonly projectGroups: JiraProjectService['projectGroups'];
  readonly rolesForGroup: JiraProjectService['rolesForGroup'];
};
