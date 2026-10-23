import { SectionShell } from "./section-shell";
import { ModelsSection } from "./settings-models-section";
import { ModelVisibilitySection } from "@/components/settings/model-visibility-section";

export function ModelsRoute() {
  return (
    <SectionShell title="模型">
      <ModelsSection />
      <ModelVisibilitySection />
    </SectionShell>
  );
}
