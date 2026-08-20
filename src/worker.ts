import { handle } from '@astrojs/cloudflare/handler';
import { runScheduledJobs } from './server/scheduled';

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return handle(request, env, ctx);
  },

  scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ) {
    return runScheduledJobs(env);
  },
};
