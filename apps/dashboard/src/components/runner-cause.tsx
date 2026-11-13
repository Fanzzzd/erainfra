import { ServerCrash } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export type RunnerCause = {
  code: string;
  summary: string;
  docs: { title: string; url: string }[];
};

/**
 * Shown when the runner, not the job's own steps, failed the run. The links go to the GitHub or
 * Blacksmith page that describes the same behaviour, so a fleet problem reads as a known one.
 */
export function RunnerCauseNote({ cause }: { cause: RunnerCause }) {
  return (
    <Alert className="*:[svg]:text-warning">
      <ServerCrash />
      <AlertTitle>The runner failed this run</AlertTitle>
      <AlertDescription>
        <p>{cause.summary}</p>
        <ul className="list-disc pl-4">
          {cause.docs.map((doc) => (
            <li key={doc.url}>
              <a href={doc.url} target="_blank" rel="noreferrer" className="text-foreground">
                {doc.title}
              </a>
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
