import type { BrowserProjectMetadata } from '../../contracts/browser-workbench';
import { StudioError } from '../../shared/errors';
import type { Project, WorkspaceManagement } from '../services/workspace-management';
import type { ProjectMetadataPort } from './dispatch';
import { WorkbenchError } from './errors';

function projectDto(project: Project): BrowserProjectMetadata {
  return { id: project.id, name: project.name, objective: project.objective, revision: project.revision ?? 0 };
}
async function safe<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof WorkbenchError) throw error;
    if (error instanceof StudioError) {
      const code = error.status === 409 ? 'conflict' : error.status === 404 ? 'not_found'
        : error.status === 403 ? 'forbidden' : error.status === 422 || error.status === 400 ? 'invalid_request' : 'internal_error';
      throw new WorkbenchError(code);
    }
    throw new WorkbenchError('internal_error');
  }
}

/** Existing domain queue, CAS and durable operation ledger own every write. */
export function createProjectMetadataPort(management: WorkspaceManagement): ProjectMetadataPort {
  return {
    readProject: (projectId, permit) => safe(async () => projectDto(await management.readProject(projectId, permit))),
    updateProject: (input, permit) => safe(async () => projectDto(await management.updateProject({ ...input }, permit))),
  };
}
