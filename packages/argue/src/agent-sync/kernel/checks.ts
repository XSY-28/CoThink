export interface CheckSelectionPlan {
  readonly tasks: readonly { readonly taskId: string; readonly checkProfileId: string }[];
  readonly profiles: readonly { readonly profileId: string; readonly checks: readonly string[] }[];
  readonly finalProfileId: string;
  readonly alwaysChecks: readonly string[];
  readonly order: readonly string[];
}
/** One deterministic selection policy for standalone and formal publication checks. */
export function resolvePublicationChecks(
  view: CheckSelectionPlan,
  acceptedTasks: readonly string[],
  taskId: string
): string[] {
  const ids = new Set([...acceptedTasks, taskId]);
  if ([...ids].some((id) => !view.tasks.some((task) => task.taskId === id)))
    throw new Error("Unknown check-selection task");
  const selected = new Set(view.alwaysChecks);
  const include = (profileId: string) => {
    const profile = view.profiles.find((p) => p.profileId === profileId);
    if (!profile) throw new Error("Missing check profile");
    for (const check of profile.checks) selected.add(check);
  };
  for (const task of view.tasks) if (ids.has(task.taskId)) include(task.checkProfileId);
  if (view.tasks.every((task) => ids.has(task.taskId))) include(view.finalProfileId);
  if ([...selected].some((id) => !view.order.includes(id))) throw new Error("Undeclared check identifier");
  return [...new Set(view.order)].filter((id) => selected.has(id));
}
