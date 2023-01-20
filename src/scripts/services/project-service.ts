import * as RTE from 'fp-ts/ReaderTaskEither';
import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';
import * as T from 'io-ts';
import { PathReporter } from 'io-ts/PathReporter';

import { pipe } from 'fp-ts/function';
import { chainableError } from './error-service';
import { ClientEnv, JiraErrorResponse, makeRequest } from './client-service';
import { progressify, ProgressReporterEnv } from './progress-service';

const JiraUser = T.readonly(
  T.type({
    displayName: T.string,
    self: T.string,
    accountId: T.string,
  })
);

const JiraProjectSummary = T.readonly(
  T.type({
    self: T.string,
    name: T.string,
    id: T.string,
    projectTypeKey: T.string,
    key: T.string,
  })
);

const JiraProject = T.intersection([
  JiraProjectSummary,
  T.readonly(
    T.type({
      lead: JiraUser,
    })
  ),
]);

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

export const BoardSummary = T.readonly(
  T.type({
    id: T.number,
    name: T.string,
  })
);

export type BoardSummary = T.TypeOf<typeof BoardSummary>;

export const BoardConfiguration = T.readonly(
  T.type({
    id: T.number,
    name: T.string,
    type: T.string,
    filter: T.readonly(
      T.partial({
        id: T.string,
        self: T.string,
      })
    ),
  })
);

export type BoardConfiguration = T.TypeOf<typeof BoardConfiguration>;

export const FilterConfiguration = T.readonly(
  T.type({
    id: T.string,
    name: T.string,
    jql: T.string,
    sharePermissions: T.readonlyArray(
      T.readonly(
        T.type({
          id: T.number,
          type: T.literal('project'),
          project: JiraProjectSummary,
        })
      )
    ),
  })
);

export type FilterConfiguration = T.TypeOf<typeof FilterConfiguration>;

export const BoardSummaryResponse = T.readonly(
  T.type({
    values: T.readonlyArray(BoardSummary),
  })
);

export type BoardSummaryResponse = T.TypeOf<typeof BoardSummaryResponse>;

export type Project = {
  readonly id: string;
  readonly key: string;
  readonly lead: {
    readonly displayName: string;
  };
  readonly groupRoles: readonly ProjectGroupRole[];
};

export type Filter = {
  readonly id: string;
  readonly jql: string;
  readonly sharePermissions: readonly {
    readonly project: {
      readonly id: string;
    };
  }[];
};

export type ProjectBoard = {
  readonly filter?: Filter;
  readonly id: number;
  readonly name: string;
  readonly type: string;
};

// eslint-disable-next-line functional/no-class
class ProjectNotFound extends Error {
  constructor(
    override readonly message: string,
    readonly projectKey: string,
    // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
    options: ErrorOptions
  ) {
    // eslint-disable-next-line functional/no-expression-statement
    super(message, options);
  }
}

export type Environment = ProgressReporterEnv & ClientEnv;

/**
 * The groups that are expected to exist.
 * @param clientCode client code.
 * @returns the groups that should exist.
 */
export const projectGroups = (clientCode: string): readonly string[] =>
  ['developers', 'business', 'administrators'].map((suffix) =>
    `${clientCode}-${suffix}`.toLowerCase()
  );

/**
 * The roles that a particular group should be assigned to in the context of a project.
 * @param group the group to determine the roles for.
 * @returns the expected role assignments for the specified group.
 */
export const rolesForGroup = (group: string): readonly string[] =>
  group.endsWith('-developers')
    ? ['Team Member']
    : group.endsWith('-business')
    ? ['Business Owner']
    : group.endsWith('-administrators')
    ? ['Administrators']
    : [];

export const fetchProject = (
  projectKey: string
): RTE.ReaderTaskEither<
  Environment,
  Error | JiraErrorResponse,
  O.Option<Project>
> => {
  return pipe(
    progressify<Environment, Error, JiraProject>(
      'Fetching project',
      pipe(
        // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types, functional/no-this-expression
        makeRequest((client) => client.getProject(projectKey)),
        RTE.chainEitherKW(
          decode(
            (_errors, undecodable) =>
              `Failed to project response for [${projectKey}] [${JSON.stringify(
                undecodable,
                null,
                2
              )}].`,
            JiraProject.asDecoder()
          )
        ),
        // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
        RTE.mapLeft((error) =>
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
        )
      )
    ),
    RTE.chain((project) => {
      return pipe(
        progressify<
          Environment,
          Error | JiraErrorResponse,
          readonly JiraProjectRoleDetails[]
          // eslint-disable-next-line functional/no-this-expression
        >('Fetching project roles', fetchProjectRoles(project.key)),
        RTE.map((roles) => {
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

    RTE.map(O.some),
    // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
    RTE.orElseW((error) => {
      return error instanceof ProjectNotFound
        ? RTE.right(O.none)
        : RTE.left(error);
    })
  );
};

/**
 * Fetches the kanban project boards for the specified project.
 * @param projectKey the key of the project to retrieve.
 * @returns the boards that are associated with the project.
 */
export const fetchProjectBoards = (
  projectKey: string
): RTE.ReaderTaskEither<
  Environment,
  Error | JiraErrorResponse,
  readonly ProjectBoard[]
> => {
  return progressify<
    Environment,
    Error | JiraErrorResponse,
    readonly ProjectBoard[]
  >(
    'Getting boards for project',
    pipe(
      // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
      makeRequest((client) =>
        client.getAllBoards(0, 10, 'kanban', undefined, projectKey)
      ),
      RTE.chainEitherKW(
        decode(
          // eslint-disable-next-line functional/functional-parameters
          (_errors, undecodable) =>
            `Failed to decode board response for [${projectKey}] [${JSON.stringify(
              undecodable,
              null,
              2
            )}].`,
          BoardSummaryResponse.asDecoder()
        )
      ),
      RTE.map((boardSummaryResponse) => boardSummaryResponse.values),
      RTE.chain(
        RTE.traverseSeqArray((boardSummary) =>
          // eslint-disable-next-line functional/no-this-expression
          fetchBoardConfiguration(boardSummary.id)
        )
      )
    )
  );
};

const fetchProjectRoleDetails = (
  projectKey: string,
  roleId: number
): RTE.ReaderTaskEither<
  Environment,
  Error | JiraErrorResponse,
  JiraProjectRoleDetails
> => {
  const path = `/project/${projectKey}/role/${roleId}`;
  return pipe(
    // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
    makeRequest((client) => client.genericGet(path)),
    RTE.chainEitherKW(
      decode(
        // eslint-disable-next-line functional/functional-parameters
        () =>
          `Failed to decode project role response for project [${projectKey}] and role [${roleId}] at path [${path}]`,
        JiraProjectRoleDetails.asDecoder()
      )
    )
  );
};

const fetchProjectRoles = (
  projectKey: string
): RTE.ReaderTaskEither<
  Environment,
  Error | JiraErrorResponse,
  readonly JiraProjectRoleDetails[]
> => {
  const path = `/project/${projectKey}/roledetails`;
  return pipe(
    // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
    makeRequest((client) => client.genericGet(path)),
    RTE.chainEitherKW(
      decode(
        // eslint-disable-next-line functional/functional-parameters
        () =>
          `Failed to decode project roles response for [${projectKey}] at path [${path}].`,
        JiraProjectRoles.asDecoder()
      )
    ),
    RTE.chain(
      RTE.traverseSeqArray((role) =>
        progressify<
          Environment,
          Error | JiraErrorResponse,
          JiraProjectRoleDetails
        >(
          `Getting role ${role.name}`,
          // eslint-disable-next-line functional/no-this-expression
          fetchProjectRoleDetails(projectKey, role.id)
        )
      )
    )
  );
};

const fetchBoardConfiguration = (
  boardId: number
): RTE.ReaderTaskEither<Environment, Error | JiraErrorResponse, ProjectBoard> =>
  progressify<Environment, Error | JiraErrorResponse, ProjectBoard>(
    `Getting board configuration ${boardId}`,
    pipe(
      // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
      makeRequest((client) => client.getConfiguration(`${boardId}`)), // Jira SDK expects a string, but API returns a number.
      RTE.chainEitherKW(
        decode(
          // eslint-disable-next-line functional/functional-parameters
          (_errors, undecodable) =>
            `Failed to decode board configuration for [${boardId}] [${JSON.stringify(
              undecodable,
              null,
              2
            )}].`,
          BoardConfiguration.asDecoder()
        )
      ),
      RTE.chain((boardConfiguration) =>
        pipe(
          // eslint-disable-next-line functional/no-this-expression
          fetchFilterForBoard(boardConfiguration),
          RTE.map((maybeFilter) => ({
            id: boardConfiguration.id,
            name: boardConfiguration.name,
            type: boardConfiguration.type,
            filter: O.toUndefined(maybeFilter),
          }))
        )
      )
    )
  );

const fetchFilterForBoard = (
  boardConfiguration: BoardConfiguration
): RTE.ReaderTaskEither<
  Environment,
  Error | JiraErrorResponse,
  O.Option<FilterConfiguration>
> =>
  boardConfiguration.filter.id !== undefined
    ? // eslint-disable-next-line functional/no-this-expression
      pipe(fetchFilter(boardConfiguration.filter.id), RTE.map(O.some))
    : RTE.right(O.none);

const fetchFilter = (
  filterId: string
): RTE.ReaderTaskEither<
  Environment,
  Error | JiraErrorResponse,
  FilterConfiguration
> =>
  progressify<Environment, Error | JiraErrorResponse, FilterConfiguration>(
    `Getting filter configuration ${filterId}`,
    pipe(
      // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
      makeRequest((client) => client.genericGet(`/filter/${filterId}`)),
      RTE.chainEitherKW(
        decode(
          (_errors, undecodable) =>
            `Failed to decode filter configuration for [${filterId}] [${JSON.stringify(
              undecodable,
              null,
              2
            )}].`,
          FilterConfiguration.asDecoder()
        )
      )
    )
  );

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
 * @param message function that will be used to build the error message if decoding fails.
 * @param decoder decoder to apply to the value.
 * @param input value to be decoded.
 * @returns either a human readable error or the decoded value.
 */
const decode =
  <I, O>(
    message: (errors: readonly string[], input: I) => string,
    decoder: T.Decoder<I, O>
  ) =>
  (input: I): E.Either<Error, O> =>
    pipe(
      input,
      decoder.decode,
      mapValidationError,
      E.mapLeft((errors) => new AggregateError(errors, message(errors, input)))
    );
