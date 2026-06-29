export class Container {
  defaultPort?: number;
  sleepAfter?: string | number;
}

export async function getRandom(namespace: { getByName(name: string): { fetch(request: Request): Promise<Response> } }, instanceCount: number) {
  return namespace.getByName(`random-${instanceCount}`);
}
