import type { Project } from "../types/project";
export function cloneProjectForWorkflow(project: Project): Project {
 const clone = structuredClone({...project, mediaLibrary: {...project.mediaLibrary, items: []}});
 return {...clone, mediaLibrary: {...project.mediaLibrary, items: [...project.mediaLibrary.items]}};
}
