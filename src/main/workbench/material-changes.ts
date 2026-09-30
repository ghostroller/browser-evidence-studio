import type { ProjectMaterials } from '../services/project-materials';

/** Shared host assembly: actual material commits/repairs invalidate scoped
 * browser readers and notify the host UI. Ordinary reads stay quiet. */
export function connectMaterialChanges(materials: ProjectMaterials, invalidate: (projectId: string) => void, changed: () => void): void {
  materials.service.onChanged = projectId => { invalidate(projectId); changed(); };
}
