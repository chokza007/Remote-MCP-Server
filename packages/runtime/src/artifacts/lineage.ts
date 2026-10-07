import type { ArtifactRelation, ArtifactRepository } from "./artifact-repository.js";

export interface ArtifactLineage {
  readonly artifactId: string;
  readonly parents: readonly ArtifactRelation[];
  readonly children: readonly ArtifactRelation[];
}

export class ArtifactLineageService {
  public constructor(private readonly repository: ArtifactRepository) {}

  public get(artifactId: string): ArtifactLineage {
    return {
      artifactId,
      parents: this.repository.parents(artifactId),
      children: this.repository.children(artifactId)
    };
  }
}
