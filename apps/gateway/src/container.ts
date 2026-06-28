import { Container } from '@cloudflare/containers';

export class ToolsEngineContainer extends Container {
  defaultPort = 8090;
  sleepAfter = '30m';
}
