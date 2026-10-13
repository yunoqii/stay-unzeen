"use client";

// WebGL eclipse for the home hero (FRONTEND.md moment 2). Loaded lazily, only on "/", only when the
// device can afford it (see hero.tsx). One full-quad fragment shader: a near-black disc, a thin Zcash
// yellow rim with a slowly breathing corona, and a "diamond ring" bead that leans toward the pointer.

import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Color, type ShaderMaterial, Vector2 } from "three";

const vertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const fragment = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform vec2 uRes;
  uniform vec2 uPointer;   // -1..1, smoothed
  uniform vec3 uAccent;
  uniform float uContact;  // M3: 0 -> 1, the disc slides into phase
  uniform float uBead;     // M3: 0 -> 1 -> 0, Baily's bead at the last point of contact
  uniform float uCorona;   // M3: 0 -> 1, the corona settles

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
    return v;
  }

  void main() {
    vec2 p = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
    float R = 0.34;
    vec2 lean = uPointer * 0.018;
    float r = length(p);
    float ang = atan(p.y, p.x);

    // corona: soft, angular streaks that drift
    float streak = fbm(vec2(ang * 2.2 + uTime * 0.03, r * 6.0 - uTime * 0.12));
    float outside = max(r - R, 0.0);
    float corona = exp(-outside * 15.0) * (0.35 + 0.65 * streak) * step(R, r);
    corona += exp(-outside * 55.0) * 0.5 * step(R, r);
    corona *= uCorona;

    // thin rim, brighter where the moon is thinnest (toward the pointer)
    vec2 dir = normalize(p + 1e-5);
    vec2 bias = normalize(vec2(0.55, 0.35) + uPointer * 0.6);
    float bead = pow(max(dot(dir, bias), 0.0), 18.0);
    float rim = smoothstep(0.006, 0.0, abs(r - R)) * (0.55 + 1.2 * bead);
    float breathe = 0.9 + 0.1 * sin(uTime * 0.6);

    // the occluding disc sits slightly off-centre and follows the pointer a little
    vec2 enter = (1.0 - uContact) * vec2(-0.03, -0.02) * 1.6;
    float moon = smoothstep(R - 0.002, R - 0.006, length(p - lean * 0.6 + bias * 0.004 - enter));
    float sheen = 1.0 - smoothstep(0.0, R * 1.2, length(p - vec2(0.1, 0.12)));
    vec3 disc = mix(vec3(0.024, 0.024, 0.027), vec3(0.07, 0.07, 0.08), sheen * 0.6);

    // the bead of light: a hot point on the rim where the disc touches last
    float bd = uBead * exp(-pow(length(p - bias * R) / 0.035, 2.0));
    vec3 glow = uAccent * (corona * 0.42 * breathe + rim + bead * exp(-outside * 30.0) * 0.6) + mix(uAccent, vec3(1.0, 0.965, 0.86), 0.6) * bd * 1.6;
    float a = clamp(max(moon, (corona * 0.42 + rim + bd) * 1.2), 0.0, 1.0);
    vec3 col = mix(glow, disc, moon);
    // fade at the quad edges so the canvas never shows a seam
    float edge = smoothstep(0.5, 0.36, max(abs(vUv.x - 0.5), abs(vUv.y - 0.5)));
    gl_FragColor = vec4(col * edge, a * edge);
  }
`;

/** M3 timeline (seconds): contact 0–1.4 (ease-out), bead 1.05–1.75 (0 → 1 at 35 % → 0), corona 1.05–1.95. */
function contactAt(t: number) {
  const c = Math.min(1, t / 1.4);
  const contact = 1 - Math.pow(1 - c, 4);
  const b = (t - 1.05) / 0.7;
  const bead = b <= 0 || b >= 1 ? 0 : b < 0.35 ? b / 0.35 : 1 - (b - 0.35) / 0.65;
  const corona = Math.min(1, Math.max(0, (t - 1.05) / 0.9));
  return { contact, bead, corona };
}

function Eclipse({ onReady, contact }: { onReady: () => void; contact: boolean }) {
  const mat = useRef<ShaderMaterial>(null);
  const size = useThree((s) => s.size);
  const target = useRef(new Vector2());
  const ready = useRef(false);
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uRes: { value: new Vector2(1, 1) },
      uPointer: { value: new Vector2() },
      uAccent: { value: new Color("#f4b728") },
      uContact: { value: contact ? 0 : 1 },
      uBead: { value: 0 },
      uCorona: { value: contact ? 0 : 1 },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial values only; the frame loop drives them
    [],
  );
  const start = useRef<number | null>(null);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      target.current.set((e.clientX / window.innerWidth) * 2 - 1, -((e.clientY / window.innerHeight) * 2 - 1));
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  useFrame((state, delta) => {
    const m = mat.current;
    if (!m) return;
    const u = m.uniforms;
    u.uTime.value = state.clock.elapsedTime;
    u.uRes.value.set(size.width, size.height);
    // critically damped follow, frame-rate independent
    const k = 1 - Math.exp(-delta * 2.5);
    (u.uPointer.value as Vector2).lerp(target.current, k);
    if (contact) {
      start.current ??= state.clock.elapsedTime;
      const c = contactAt(state.clock.elapsedTime - start.current);
      u.uContact.value = c.contact;
      u.uBead.value = c.bead;
      u.uCorona.value = c.corona;
    } else {
      u.uContact.value = 1;
      u.uBead.value = 0;
      u.uCorona.value = 1;
    }
    if (!ready.current) {
      ready.current = true;
      onReady();
    }
  });

  return (
    <mesh frustumCulled={false}>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial ref={mat} vertexShader={vertex} fragmentShader={fragment} uniforms={uniforms} transparent depthWrite={false} />
    </mesh>
  );
}

export default function EclipseGL({ onReady, active, contact = false }: { onReady: () => void; active: boolean; contact?: boolean }) {
  return (
    <Canvas
      frameloop={active ? "always" : "never"}
      dpr={[1, 1.5]}
      gl={{ alpha: true, antialias: false, powerPreference: "low-power", premultipliedAlpha: false }}
      style={{ position: "absolute", inset: 0 }}
      aria-hidden
    >
      <Eclipse onReady={onReady} contact={contact} />
    </Canvas>
  );
}
