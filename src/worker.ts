import { handle } from '@astrojs/cloudflare/handler';
import { cleanupVerificationState } from './server/cleanup/verification';

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return handle(request, env, ctx);
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ) {
    try {
      const result = await cleanupVerificationState(env);
      console.log(
        `[cleanup] verification=${result.verificationRows} manual_approval=${result.manualApprovalRows}`,
      );
    } catch (err) {
      console.error('[cleanup] failed', err);
      throw err;
    }
  },
};
