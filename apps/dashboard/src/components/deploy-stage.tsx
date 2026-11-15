import { Status } from "@/components/status";
import { deployStageStates, isDeployStage } from "@/lib/states";

/** A deployment run's stage. A stage the dashboard does not know shows neutral, under its own name. */
export function DeployStageStatus({ stage }: { stage: string }) {
  if (isDeployStage(stage)) return <Status states={deployStageStates} state={stage} />;
  return <Status state="idle">{stage}</Status>;
}
