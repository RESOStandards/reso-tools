import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';

/**
 * Creates an Express router that serves Swagger UI at /api-docs.
 * Also serves the raw OpenAPI JSON spec at /api-docs/spec.json.
 */
export const createSwaggerRouter = (spec: Record<string, unknown>): Router => {
  const router = Router();

  router.get('/api-docs/spec.json', (_req, res) => {
    res.json(spec);
  });

  // Inject a floating "Back to RESO" button into Swagger UI
  router.get('/api-docs/back-btn.js', (_req, res) => {
    res.type('application/javascript').send(`
      (function() {
        var btn = document.createElement('button');
        btn.textContent = '\\u2190 Back to RESO';
        btn.style.cssText = 'position:fixed;top:12px;right:16px;z-index:9999;padding:6px 14px;font-size:13px;font-weight:600;background:#1a1a2e;color:#fff;border:none;border-radius:8px;cursor:pointer;font-family:system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,0.2)';
        btn.onmouseover = function() { btn.style.background = '#2d2d4a'; };
        btn.onmouseout = function() { btn.style.background = '#1a1a2e'; };
        btn.onclick = function() { window.location.href = '/'; };
        document.body.appendChild(btn);
      })();
    `);
  });

  router.use('/api-docs', swaggerUi.serve, swaggerUi.setup(spec, {
    customJs: '/api-docs/back-btn.js',
  }));

  return router;
};
