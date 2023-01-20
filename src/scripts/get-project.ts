import { Argv } from 'yargs';
import { RootCommand } from '..';

import * as RTE from 'fp-ts/ReaderTaskEither';
import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';
import { pipe } from 'fp-ts/function';
import * as Console from 'fp-ts/Console';
import { jiraClient } from './services/client-service';
import {
  Filter,
  Project,
  ProjectBoard,
  rolesForGroup,
  projectGroups,
  fetchProject,
  fetchProjectBoards,
} from './services/project-service';
import { chainableError } from './services/error-service';
import * as RNEA from 'fp-ts/ReadonlyNonEmptyArray';
import * as Ap from 'fp-ts/Apply';
import { OraProgressReporter } from './services/progress-service';

const applicativeValidation = E.getApplicativeValidation(
  RNEA.getSemigroup<string>()
);

const difference = <A>(
  a1s: readonly A[],
  a2s: readonly A[]
): readonly [readonly A[], readonly A[]] => {
  const missingFromA2: readonly A[] = a1s.filter((a) => !a2s.includes(a));
  const missingFromA1: readonly A[] = a2s.filter((a) => !a1s.includes(a));

  return [missingFromA2, missingFromA1];
};

const validatedGroup = (
  project: Project,
  group: string
): E.Either<RNEA.ReadonlyNonEmptyArray<string>, string> => {
  const hasGroup = project.groupRoles.some((groupRole) =>
    groupRole.groups.some((g) => g.displayName === group)
  )
    ? E.right(group)
    : E.left(RNEA.of(`Project does not have required group [${group}].`));

  const actualRoles: readonly unknown[] = project.groupRoles
    .filter((groupRole) =>
      groupRole.groups.some((g) => g.displayName === group)
    )
    .map((groupRole) => groupRole.role);

  const expectedRoles = rolesForGroup(group);

  const [extraRoles, missingRoles] = difference(actualRoles, expectedRoles);

  const hasNoMissingRoles =
    missingRoles.length === 0
      ? E.right(group)
      : E.left(RNEA.of(`Missing roles [${missingRoles.join(', ')}]`));
  const hasNoExtraRoles =
    extraRoles.length === 0
      ? E.right(group)
      : E.left(RNEA.of(`Extra roles [${extraRoles.join(', ')}]`));

  return pipe(
    hasGroup,
    E.chain((group) =>
      pipe(
        Ap.sequenceT(applicativeValidation)(hasNoMissingRoles, hasNoExtraRoles),
        E.map((_) => group)
      )
    )
  );
};

const validatedFilter = (
  project: Project,
  board: ProjectBoard
): E.Either<RNEA.ReadonlyNonEmptyArray<string>, Filter> => {
  const hasFilter =
    board.filter !== undefined
      ? E.right(board.filter)
      : E.left(RNEA.of('Project board does not have a filter.'));

  const filterHasPermissions = (filter: Filter) =>
    filter.sharePermissions.some(
      (permission) => permission.project.id === project.id
    )
      ? E.right(filter)
      : E.left(RNEA.of('Filter is not shared with project.'));

  return pipe(hasFilter, E.chain(filterHasPermissions));
};

const projectSummary = (
  project: Project,
  boards: readonly ProjectBoard[],
  clientCode: string
) => {
  const groups = projectGroups(clientCode);

  const groupRoles = groups
    .map((expectedGroup) => {
      const roles = project.groupRoles
        .filter((groupRole) =>
          groupRole.groups.find((group) => group.displayName === expectedGroup)
        )
        .map((groupRole) => groupRole.role)
        .join();

      const validated = validatedGroup(project, expectedGroup);

      const validMessage = E.isLeft(validated)
        ? `❌ (${validated.left.join(', ')})`
        : '✅';

      return `${expectedGroup}: [${roles}] ${validMessage}`;
    })
    .map((s) => `  ${s}`)
    .join('\n');

  const validatedBoards = boards
    .map((board) => {
      const validMessage = pipe(
        validatedFilter(project, board),

        E.fold(
          (errors) => `❌ (${errors.join(', ')})`,
          (filter) => `✅\n      jql: ${filter.jql}`
        )
      );

      return `${board.name}:\n    type: ${board.type}\n    filter: ${validMessage}`;
    })
    .map((s) => `  ${s}`)
    .join('\n');

  const summary = `
id: ${project.id}
key: ${project.key}
lead: ${project.lead.displayName}
groups:
${groupRoles}
boards:
${validatedBoards}
  `;
  return Console.info(summary);
};

const project = (projectKey: string, clientCode: string, verbose: boolean) =>
  pipe(
    Ap.sequenceT(RTE.ApplyPar)(
      fetchProject(projectKey),
      fetchProjectBoards(projectKey)
    ),
    // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
    RTE.chainFirstIOK(([maybeProject, boards]) =>
      pipe(
        maybeProject,
        O.fold(
          // eslint-disable-next-line functional/functional-parameters
          () =>
            Console.warn(
              `Project [${projectKey}] does not exist or is not visible.`
            ),
          (project) =>
            verbose
              ? Console.info(JSON.stringify(boards, null, 2))
              : projectSummary(project, boards, clientCode)
        )
      )
    )
  );

export default (
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  rootCommand: RootCommand
): Argv<{
  readonly username: string;
  readonly password: string;
  readonly projectKey: string;
  readonly clientCode: string;
  readonly verbose: boolean;
}> =>
  rootCommand.command(
    'get-project',
    'Fetches details of a Jira project and checks whether the project is configured correctly',
    // eslint-disable-next-line functional/no-return-void, @typescript-eslint/prefer-readonly-parameter-types
    (yargs) => {
      // eslint-disable-next-line functional/no-expression-statement
      yargs
        .option('project-key', {
          type: 'string',
          alias: ['key'],
          describe: 'The key of the project',
          demandOption: true,
        })
        .option('client-code', {
          type: 'string',
          alias: ['client'],
          describe: 'The code of the client',
          demandOption: true,
        })
        .option('verbose', {
          type: 'boolean',
          alias: ['v'],
          describe: 'Enable verbose mode',
          default: false,
        });
    },
    async (args: {
      readonly username: string;
      readonly password: string;
      readonly projectKey: string;
      readonly clientCode: string;
      readonly verbose: boolean;
    }) => {
      const client = jiraClient({ ...args });

      const env = {
        client,
        progressReporter: OraProgressReporter,
      };

      const result = await project(
        args.projectKey,
        args.clientCode,
        args.verbose
      )(env)();

      // eslint-disable-next-line functional/no-conditional-statement
      if (E.isLeft(result)) {
        // eslint-disable-next-line functional/no-throw-statement
        throw new Error(
          `Failed to get project [${args.projectKey}].`,
          chainableError(result.left)
        );
      }
    }
  );
