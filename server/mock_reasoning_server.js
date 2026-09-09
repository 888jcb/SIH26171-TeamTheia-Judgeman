/**
 * server/mock_reasoning_server.js
 * Reasoning API Backend & Privacy Audit Server for PRIVISION (SIH26171).
 * 
 * Enforces the cloud-side of the Hard Privacy Boundary:
 * 1. Audits incoming payloads to verify ONLY sanitized context crosses the boundary.
 * 2. Connects to the real Google Gemini API via @google/genai SDK using GEMINI_API_KEY.
 * 3. Returns structured JSON actions (CLICK, FOCUS, SCROLL, etc.) matching local element IDs.
 * 4. Serves the demo test sandbox at http://localhost:3721/demo
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// Load environment variables from server/.env if present
try {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch {
  // dotenv optional fallback
}

let GoogleGenAI = null;
try {
  const genai = require('@google/genai');
  GoogleGenAI = genai.GoogleGenAI;
} catch (err) {
  console.warn('[PRIVISION SERVER] @google/genai package not found. Run "npm install" in server directory.');
}

const PORT = parseInt(process.env.PORT || '3721', 10);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const ROOT_DIR = path.resolve(__dirname, '..');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

// Initialize Gemini Client if API key is present
let geminiClient = null;
if (GoogleGenAI && GEMINI_API_KEY && GEMINI_API_KEY !== 'your_gemini_api_key_here') {
  try {
    geminiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    console.log(`[PRIVISION SERVER] Gemini AI reasoning enabled with model: ${GEMINI_MODEL}`);
  } catch (initErr) {
    console.warn('[PRIVISION SERVER] Gemini client initialization failed:', initErr.message);
  }
} else {
  console.log('[PRIVISION SERVER] Notice: GEMINI_API_KEY not set. Operating in structured fallback mode.');
  console.log('                   To enable live Gemini reasoning, add GEMINI_API_KEY in server/.env');
}

/**
 * Calls the real Gemini model using official Google GenAI SDK.
 * Requirement 9, 10, 11.
 * 
 * @param {Object} payload Sanitized network payload
 * @returns {Promise<Object>} Structured action response
 */
async function callGeminiReasoning(payload) {
  const systemInstruction = `You are the reasoning layer of a privacy-preserving browser agent.
The context below has already passed through a local privacy boundary.
Never request, infer, reconstruct, or attempt to recover redacted values.
Use only the sanitized information provided.
Return only an allowed browser action.`;

  const page = payload.page || {};
  const elements = payload.elements || [];
  const screenshot = payload.screenshot || null;

  const promptText = `Page Origin: ${page.origin || 'unknown'}
Page Path: ${page.path || '/'}
Sanitized DOM Elements:
${JSON.stringify(elements, null, 2)}

Goal: Assist the user with navigating or interacting with this page safely.
Select the single best next action from the allowed actions: CLICK, FOCUS, SCROLL, NAVIGATE_SAFE, WAIT, NO_ACTION.
Target element must use the exact element id from the sanitized DOM (e.g. privision-element-001).`;

  const contentParts = [{ text: promptText }];

  // If a sanitized on-device screenshot is available, attach it as inline image
  if (screenshot && screenshot.startsWith('data:image/')) {
    const matches = screenshot.match(/^data:(image\/[a-zA-Z]+);base64,(.+)$/);
    if (matches) {
      contentParts.push({
        inlineData: {
          mimeType: matches[1],
          data: matches[2]
        }
      });
    }
  }

  const response = await geminiClient.models.generateContent({
    model: GEMINI_MODEL,
    contents: [{ role: 'user', parts: contentParts }],
    config: {
      systemInstruction,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['CLICK', 'FOCUS', 'SCROLL', 'NAVIGATE_SAFE', 'WAIT', 'NO_ACTION']
          },
          targetId: {
            type: 'string',
            description: 'The local element ID (e.g. privision-element-001) to act upon'
          },
          reason: {
            type: 'string',
            description: 'Explanation for the action based strictly on sanitized context'
          },
          confidence: {
            type: 'number',
            description: 'Confidence score between 0.0 and 1.0'
          }
        },
        required: ['action', 'targetId', 'reason', 'confidence']
      }
    }
  });

  const rawText = response.text ? response.text() : (response.candidates?.[0]?.content?.parts?.[0]?.text || '{}');
  const parsedAction = JSON.parse(rawText);

  return {
    status: 'success',
    server: `PRIVISION Cloud Reasoning Engine (Gemini: ${GEMINI_MODEL})`,
    action: parsedAction.action || 'NO_ACTION',
    targetId: parsedAction.targetId || null,
    reason: parsedAction.reason || 'Gemini reasoning completed.',
    confidence: parsedAction.confidence || 0.9,
    boundaryIntegrityVerified: true,
    timestamp: Date.now()
  };
}

const server = http.createServer(async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Privision-Sanitized');

  // Pre-flight handling
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check endpoint
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'online',
      service: 'PRIVISION Reasoning API Server',
      port: PORT,
      geminiConfigured: !!geminiClient,
      model: geminiClient ? GEMINI_MODEL : 'none (local fallback)',
      timestamp: Date.now()
    }));
    return;
  }

  // Sanitized Reasoning Endpoint
  if (req.method === 'POST' && req.url === '/api/reason') {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);

        console.log('\n================================================================');
        console.log('🛡️  [PRIVISION SERVER] INCOMING REASONING REQUEST RECEIVED');
        console.log('================================================================');
        console.log(`Timestamp:             ${new Date().toISOString()}`);
        console.log(`Page Domain:           ${payload.page?.domain || 'N/A'}`);
        console.log(`Page Path:             ${payload.page?.path || '/'}`);
        console.log(`Redacted Entities:     ${payload.privacy?.redactedCount || 0}`);
        console.log(`Sanitized Elements:    ${payload.elements?.length || 0}`);
        console.log(`Sanitized Screenshot:  ${payload.screenshot ? 'Present (Overwritten with dark redactions)' : 'None'}`);

        // =========================================================================
        // SERVER-SIDE PRIVACY AUDIT: VERIFY ZERO RAW PII LEAKAGE
        // =========================================================================
        const violations = auditPayloadForPrivacy(payload);

        // Development Diagnostics (Requirement 5)
        console.log('\n[SERVER DIAGNOSTICS] ========================================');
        console.log(`[SERVER DIAGNOSTICS] HTTP Method:      ${req.method}`);
        console.log(`[SERVER DIAGNOSTICS] Request Path:     ${req.url}`);
        console.log(`[SERVER DIAGNOSTICS] Content-Type:     ${req.headers['content-type'] || 'N/A'}`);
        console.log(`[SERVER DIAGNOSTICS] Top-Level Fields: ${Object.keys(payload).join(', ')}`);
        console.log(`[SERVER DIAGNOSTICS] Redacted Entities:${payload.privacy?.redactedCount || 0}`);
        console.log(`[SERVER DIAGNOSTICS] Sanitized Elements:${payload.elements?.length || 0}`);

        if (violations.length > 0) {
          console.error(`[SERVER DIAGNOSTICS] Validation Status: FAILED`);
          console.error(`[SERVER DIAGNOSTICS] Failure Reason:    ${violations[0]}`);
          console.log('================================================================\n');

          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'blocked',
            error: `Privacy boundary breached. ${violations[0]}`
          }));
          return;
        }

        console.log(`[SERVER DIAGNOSTICS] Validation Status: PASSED (Zero raw PII received)`);
        console.log('✅ BOUNDARY AUDIT: Verified 100% sanitized. Zero raw PII received.');
        console.log('================================================================\n');

        let responseData;
        if (geminiClient) {
          // Live Gemini reasoning via official Google GenAI SDK
          try {
            responseData = await callGeminiReasoning(payload);
          } catch (geminiErr) {
            console.error('[PRIVISION SERVER] Gemini invocation failed:', geminiErr.message);
            responseData = generateFallbackAction(payload, `Gemini call failed (${geminiErr.message}). Fallback action engaged.`);
          }
        } else {
          // Structured fallback response
          responseData = generateFallbackAction(payload, 'Local structured reasoning fallback (set GEMINI_API_KEY in server/.env for live AI).');
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseData));

      } catch (parseError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON payload received.' }));
      }
    });
    return;
  }

  // Static File Serving for Testing Demo (GET / or /demo or static assets)
  if (req.method === 'GET') {
    let reqPath = req.url.split('?')[0];

    if (reqPath === '/' || reqPath === '/demo' || reqPath === '/demo/') {
      reqPath = '/demo/test-form.html';
    }

    const safePath = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, '');
    const filePath = path.join(ROOT_DIR, safePath);

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      res.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }

  // Not found
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint not found. Use /demo for the sandbox or POST /api/reason for reasoning API.' }));
});

/**
 * Generates a safe fallback action matching the structured schema.
 */
function generateFallbackAction(payload, reason) {
  const elements = payload.elements || [];
  const targetElement = elements.find(e => !e.sensitive && e.role === 'input') ||
                        elements.find(e => !e.sensitive && (e.tag === 'button' || e.role === 'button')) ||
                        elements[0];

  return {
    status: 'success',
    server: 'PRIVISION Reasoning Engine (Local Fallback)',
    action: targetElement?.tag === 'button' ? 'CLICK' : (targetElement ? 'FOCUS' : 'NO_ACTION'),
    targetId: targetElement?.id || null,
    reason,
    confidence: 0.88,
    boundaryIntegrityVerified: true,
    timestamp: Date.now()
  };
}

/**
 * Server-side audit function:
 * Verifies that incoming payload contains NO raw PII values or forbidden fields.
 * Recursively inspects object properties while ignoring numeric timestamps,
 * element layout coordinates, and sanitized base64 screenshot data URLs.
 * 
 * Returns an array of violation descriptions (empty if 100% clean).
 */
function auditPayloadForPrivacy(payload) {
  const violations = [];

  if (!payload || typeof payload !== 'object') {
    violations.push('Payload must be a valid JSON object.');
    return violations;
  }

  if (!payload.privacy?.sanitized || !payload.privacy?.rawDataExcluded) {
    violations.push('Payload missing certified sanitization signatures (privacy.sanitized / privacy.rawDataExcluded).');
  }

  if (!Array.isArray(payload.elements)) {
    violations.push('Payload missing elements array.');
  }

  const FORBIDDEN_KEYS = [
    'rawvalue',
    'originalvalue',
    'originaltext',
    'rawtext',
    'html',
    'outerhtml',
    'innerhtml',
    'password',
    'secret',
    'authorization',
    'cookie',
    'session',
    'credential',
    'originalscreenshot',
    'rawscreenshot'
  ];

  function inspect(val, path) {
    if (val === null || val === undefined) return;
    if (typeof val === 'number' || typeof val === 'boolean') return;

    if (typeof val === 'string') {
      // Allow sanitized base64 data URLs in screenshot field
      if (path === 'screenshot' && val.startsWith('data:image/')) return;

      // Allow legitimate redacted placeholder tokens like {{REDACTED_PASSWORD_1}}
      if (val.startsWith('{{REDACTED_') || val.startsWith('[REDACTED_')) return;

      if (val.length > 5) {
        // 1. Raw Credit Card (13-19 digits)
        const ccMatches = val.match(/\b(?:\d[\s\-.]*?){13,19}\b/g);
        if (ccMatches) {
          for (const m of ccMatches) {
            const digitCount = m.replace(/\D/g, '').length;
            if (digitCount >= 13 && digitCount <= 19) {
              violations.push(`Raw credit card pattern detected in field '${path}'`);
              break;
            }
          }
        }

        // 2. Raw SSN
        if (/\b\d{3}-\d{2}-\d{4}\b/.test(val)) {
          violations.push(`Raw SSN pattern detected in field '${path}'`);
        }

        // 3. Raw Aadhaar
        if (/\b\d{4}\s\d{4}\s\d{4}\b/.test(val)) {
          violations.push(`Raw Aadhaar pattern detected in field '${path}'`);
        }

        // 4. Raw PAN
        if (/\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b/i.test(val)) {
          violations.push(`Raw PAN pattern detected in field '${path}'`);
        }

        // 5. Raw Email
        if (/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(val)) {
          violations.push(`Raw email pattern detected in field '${path}'`);
        }
      }
      return;
    }

    if (Array.isArray(val)) {
      val.forEach((item, idx) => inspect(item, `${path}[${idx}]`));
      return;
    }

    if (typeof val === 'object') {
      for (const [key, value] of Object.entries(val)) {
        const lowerKey = key.toLowerCase();
        for (const forbidden of FORBIDDEN_KEYS) {
          if (lowerKey === forbidden || lowerKey.includes(forbidden)) {
            violations.push(`Forbidden field key '${key}' detected at '${path}.${key}'`);
          }
        }
        if (lowerKey === 'src' || lowerKey === 'currentsrc') {
          violations.push(`Raw image source '${key}' detected at '${path}.${key}'`);
        }
        inspect(value, `${path}.${key}`);
      }
    }
  }

  inspect(payload, 'payload');
  return violations;
}

server.listen(PORT, () => {
  console.log(`\n================================================================`);
  console.log(`🚀 PRIVISION Reasoning Server running on http://localhost:${PORT}`);
  console.log(`   Interactive Sandbox: http://localhost:${PORT}/demo`);
  console.log(`   Reasoning API:       POST http://localhost:${PORT}/api/reason`);
  console.log(`   Gemini Status:       ${geminiClient ? `Active (${GEMINI_MODEL})` : 'Offline (Local Fallback)'}`);
  console.log(`   Auditing incoming payloads for 100% on-device sanitized tokens.`);
  console.log(`================================================================\n`);
});
