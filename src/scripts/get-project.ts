import { Argv } from 'yargs';
import { RootCommand } from '..';

import * as TE from 'fp-ts/lib/TaskEither';
import * as E from 'fp-ts/lib/Either';
import * as O from 'fp-ts/lib/Option';
import { pipe } from 'fp-ts/lib/function';
import * as Console from 'fp-ts/lib/Console';
import { jiraClient } from './services/client-service';
import {
  JiraProjectService,
  Project,
  ProjectService,
} from './services/project-service';
import { chainableError } from './services/error-service';
import * as NEA from 'fp-ts/lib/NonEmptyArray';
import * as Ap from 'fp-ts/lib/Apply';

const applicativeValidation = E.getApplicativeValidation(
  NEA.getSemigroup<string>()
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
  service: ProjectService,
  project: Project,
  group: string
): E.Either<NEA.NonEmptyArray<string>, string> => {
  const hasGroup = project.groupRoles.some((groupRole) =>
    groupRole.groups.some((g) => g.displayName === group)
  )
    ? E.right(group)
    : E.left(NEA.of(`Project does not have required group [${group}].`));

  const actualRoles: readonly unknown[] = project.groupRoles
    .filter((groupRole) =>
      groupRole.groups.some((g) => g.displayName === group)
    )
    .map((groupRole) => groupRole.role);

  const expectedRoles = service.rolesForGroup(group);

  const [extraRoles, missingRoles] = difference(actualRoles, expectedRoles);

  const hasNoMissingRoles =
    missingRoles.length === 0
      ? E.right(group)
      : E.left(NEA.of(`Missing roles [${missingRoles.join(', ')}]`));
  const hasNoExtraRoles =
    extraRoles.length === 0
      ? E.right(group)
      : E.left(NEA.of(`Extra roles [${extraRoles.join(', ')}]`));

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

const projectSummary = (
  service: ProjectService,
  project: Project,
  clientCode: string
) => {
  const groups = service.projectGroups(clientCode);

  const groupRoles = groups
    .map((expectedGroup) => {
      const roles = project.groupRoles
        .filter((groupRole) =>
          groupRole.groups.find((group) => group.displayName === expectedGroup)
        )
        .map((groupRole) => groupRole.role)
        .join();

      const valid = validatedGroup(service, project, expectedGroup);

      const validMessage = E.isLeft(valid)
        ? `❌ (${valid.left.join(', ')})`
        : '✅';

      return `${expectedGroup}: [${roles}] ${validMessage}`;
    })
    .map((s) => `  ${s}`)
    .join('\n');

  const summary = `
id: ${project.id}
key: ${project.key}
lead: ${project.lead.displayName}
groups:
${groupRoles}
  `;
  return Console.info(summary);
};

const project = (
  service: ProjectService,
  projectKey: string,
  clientCode: string,
  verbose: boolean
) =>
  pipe(
    service.getProject(projectKey),
    TE.chainFirstIOK((maybeProject) =>
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
              ? Console.info(JSON.stringify(project, null, 2))
              : projectSummary(service, project, clientCode)
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
    // eslint-disable-next-line quotes
    "Provides a list of all users' ID's, email addresses, display names, and statuses. Allows a specification of a group to list from.",
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
      const projectService = new JiraProjectService(client);

      const result = await project(
        projectService,
        args.projectKey,
        args.clientCode,
        args.verbose
      )();

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
