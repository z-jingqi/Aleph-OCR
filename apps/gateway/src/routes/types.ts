import type { Hono } from 'hono';
import type { AuthVariables } from '../auth';
import type { Env } from '../types';

export type GatewayApp = Hono<{ Bindings: Env; Variables: AuthVariables }>;
