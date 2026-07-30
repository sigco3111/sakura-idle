export const duration = 2;
export const fps = 24;
export const audio = false;   // audio module has no renderOffline yet
export const ui = true;
export const pageScript = `
window.__STORY = {
  setup(g, ctx) { ctx.assets.game?.state && (ctx.assets.game.state.petals = 5000); },
  frame(t, g, ctx) {
    g.setCamera('hero');
    ctx.camera.position.x += Math.sin(t * 0.8) * 1.5;
    ctx.camera.lookAt(0, 7.5, 0);
    if (Math.abs(t - 1.0) < 0.03) ctx.assets.game?.shake?.({x:0,y:8,z:0});
  },
};
`;
