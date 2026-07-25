import type { ToolOutputArtifact } from "@deep-mix/shared-schema";
import { Icon } from "./Icons";

interface ToolOutputArtifactsProps {
  artifacts?: ToolOutputArtifact[];
  compact?: boolean;
}

function artifactLocations(artifact: ToolOutputArtifact): string[] {
  return [artifact.workspaceRelativePath, artifact.uri]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index);
}

export function ToolOutputArtifacts({ artifacts = [], compact = false }: ToolOutputArtifactsProps) {
  if (artifacts.length === 0) return null;

  return (
    <div className={`tool-output-artifacts${compact ? " tool-output-artifacts--compact" : ""}`} aria-label="工具产物">
      {artifacts.map((artifact, index) => (
        <div className="tool-output-artifact" key={`${artifact.uri}-${index}`}>
          <span className="tool-output-artifact__icon"><Icon name="file" size={14} /></span>
          <div className="tool-output-artifact__copy">
            <strong title={artifact.fileName}>{artifact.fileName}</strong>
            <small>{artifact.kind} · {artifact.mimeType}</small>
            {artifactLocations(artifact).map((location) => (
              <code title={location} key={location}>{location}</code>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
