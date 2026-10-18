/*
 * Turns a painted source canvas into a halftone, the way the ascii.rest scenes
 * draw: each cell's brightness picks one of a few dot sizes (ordered dithered),
 * and its colour is snapped to a few levels so the picture stays crisp. It runs
 * on the GPU at the screen's own resolution. Inside the scope the picture is
 * magnified and the grid gets finer.
 */

const VERT = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D src;
uniform vec2 res;       // canvas size in device pixels
uniform float cell;     // pitch in device pixels
uniform float fill;     // the largest dot as a share of its cell
uniform float square;   // 1 for square pixels, 0 for round dots
uniform float glow;     // how much soft light shows between the cells
uniform vec3 ground;
uniform vec3 scope;     // centre x, centre y (device px, top-left origin), radius
uniform float zoom;
out vec4 outColor;

float bayer(vec2 c) {
  ivec2 i = ivec2(mod(c, 4.0));
  int k = i.x + i.y * 4;
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return float(m[k]) / 16.0 - 0.47;
}

vec3 halftone(vec2 px, float pitch, float z) {
  vec2 id = floor(px / pitch);
  vec2 centre = (id + 0.5) * pitch;
  vec2 at = scope.xy + (centre - scope.xy) / z;
  vec3 c = texture(src, at / res).rgb;
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  // stretch the tones so silhouettes drop out and lit edges carry full dots
  float tone = smoothstep(0.065, 0.8, lum);
  float level = clamp(floor(pow(tone, 0.8) * 4.6 + bayer(id) * 0.95 + 0.15), 0.0, 4.0);
  float size = level == 0.0 ? 0.0 : (0.3 + level * 0.175) * fill;
  float peak = max(max(c.r, c.g), max(c.b, 0.001));
  vec3 ink = c / peak * mix(0.45, 1.0, tone);
  ink = floor(ink * 7.0 + 0.5) / 7.0;
  vec2 q = abs(px - centre);
  float half_ = pitch * size * 0.5;
  float d = square > 0.5 ? max(q.x, q.y) : length(q);
  float a = smoothstep(half_ + 0.6, half_ - 0.6, d);
  // a little light between the brightest cells, as on a real screen
  vec3 under = ground + c * mix(0.1 * tone * tone, 0.75 * tone, glow);
  return mix(under, ink, a);
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, res.y - gl_FragCoord.y);
  vec3 col = halftone(px, cell, 1.0);
  if (scope.z > 0.0) {
    float d = length(px - scope.xy);
    float inside = smoothstep(scope.z, scope.z - 2.0, d);
    if (inside > 0.0) {
      vec3 lens = halftone(px, cell * 0.55, zoom) * 1.1;
      col = mix(col * 0.55, lens, inside);
    } else {
      col *= 0.55 + 0.45 * smoothstep(scope.z, scope.z + 220.0, d);
    }
  }
  outColor = vec4(col, 1.0);
}`;

export interface HalftoneStyle {
  /** Pitch between cell centres, in CSS pixels. */
  cell: number;
  /** Largest dot as a share of its cell, 0..1. */
  fill: number;
  shape: "square" | "round";
  /** Soft light between the cells, 0 for crisp dots on black, 1 for a lit haze. */
  glow: number;
  /** Ground colour as linear 0..1 RGB. */
  ground: readonly [number, number, number];
}

export interface Scope {
  x: number;
  y: number;
  r: number;
}

export interface Halftone {
  render(source: HTMLCanvasElement, scope: Scope | null, zoom: number): void;
  resize(width: number, height: number, dpr: number): void;
  dispose(): void;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/** Returns null when WebGL2 is unavailable, so the caller can show the painted canvas instead. */
export function createHalftone(canvas: HTMLCanvasElement, style: HalftoneStyle): Halftone | null {
  const gl = canvas.getContext("webgl2", {
    antialias: false,
    alpha: false,
    premultipliedAlpha: false,
  });
  if (!gl) return null;
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  const program = gl.createProgram();
  // on any setup failure, release what was made and the context itself
  const fail = () => {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    if (program) gl.deleteProgram(program);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return null;
  };
  if (!vs || !fs || !program) return fail();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return fail();
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(program, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const u = {
    res: gl.getUniformLocation(program, "res"),
    cell: gl.getUniformLocation(program, "cell"),
    fill: gl.getUniformLocation(program, "fill"),
    square: gl.getUniformLocation(program, "square"),
    glow: gl.getUniformLocation(program, "glow"),
    ground: gl.getUniformLocation(program, "ground"),
    scope: gl.getUniformLocation(program, "scope"),
    zoom: gl.getUniformLocation(program, "zoom"),
  };
  gl.uniform1f(u.fill, style.fill);
  gl.uniform1f(u.square, style.shape === "square" ? 1 : 0);
  gl.uniform1f(u.glow, style.glow);
  gl.uniform3f(u.ground, style.ground[0], style.ground[1], style.ground[2]);

  return {
    resize(width, height, dpr) {
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
      gl.uniform2f(u.res, width, height);
      // finer cells on a phone, so a small frame still holds enough of them to read
      const narrow = width / dpr < 640 ? 0.68 : 1;
      gl.uniform1f(u.cell, style.cell * narrow * dpr);
    },
    render(source, scope, zoom) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.uniform1f(u.zoom, zoom);
      gl.uniform3f(u.scope, scope?.x ?? 0, scope?.y ?? 0, scope?.r ?? 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose() {
      gl.deleteTexture(texture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
