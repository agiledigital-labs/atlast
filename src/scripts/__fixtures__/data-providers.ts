/* eslint-disable functional/no-return-void */
/* eslint-disable functional/no-expression-statement */
/* eslint-disable functional/functional-parameters */
import * as TE from 'fp-ts/TaskEither';
import { Project, ProjectService } from '../services/project-service';

export const returnLeftTE = jest.fn(() =>
  TE.left(new Error('An error occurred'))
);

export const project: Project = {
  id: 'project-id',
  key: 'project-key',
  lead: {
    displayName: 'lead-display-name',
  },
  groupRoles: [],
};

export const baseProjectService = (): ProjectService => ({
  getProject: returnLeftTE,
  projectGroups: (_key: string) => [],
});
