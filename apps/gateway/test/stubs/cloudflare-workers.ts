export class WorkflowEntrypoint<Env = unknown, Params = unknown> {
  env!: Env;
  async run(_event: Readonly<{ payload: Params }>, _step: unknown): Promise<unknown> {
    return undefined;
  }
}

