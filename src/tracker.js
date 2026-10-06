import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

const LEFT_IRIS = 468;
const RIGHT_IRIS = 473;

// Webcam face tracker. Reports the midpoint between the eyes in camera space
// (meters; x right in the image, y down in the image, z along the optical axis).
export class FaceTracker {
  constructor(video, params, onSample) {
    this.video = video;
    this.params = params;
    this.onSample = onSample;
    this.landmarker = null;
    this.stream = null;
    this.status = "off";
    this.fps = 0;
    this.inferMs = 0;
    this.lastLandmarks = null;
    this.lastIpdPx = 0;
    this.lastYawScale = 1;
    this._lastFrameT = 0;
    this._lastTs = 0;
  }

  async init() {
    this.status = "loading model";
    // Resolved against the page address, so it works from any hosting path.
    const base = new URL(`${import.meta.env.BASE_URL}mediapipe`, document.baseURI).href;
    const fileset = await FilesetResolver.forVisionTasks(base);
    const options = (delegate) => ({
      baseOptions: { modelAssetPath: `${base}/face_landmarker.task`, delegate },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFacialTransformationMatrixes: true,
    });
    try {
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, options("GPU"));
    } catch (err) {
      console.warn("GPU delegate failed, using CPU", err);
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, options("CPU"));
    }
    this.status = "model ready";
  }

  async listCameras() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "videoinput");
  }

  async start(deviceId) {
    this.stop();
    this.status = "opening camera";
    // Frame rate matters more than resolution here. Many webcams only reach
    // their top rate in one specific mode (often 1280x720), so insist on a
    // fast mode first and relax step by step if the camera refuses.
    const id = deviceId ? { exact: deviceId } : undefined;
    const attempts = [
      { deviceId: id, frameRate: { min: 90, ideal: 240 } },
      { deviceId: id, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { min: 50, ideal: 60 } },
      { deviceId: id, frameRate: { min: 50, ideal: 60 } },
      { deviceId: id, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 } },
    ];
    this.stream = null;
    let lastError = null;
    for (const video of attempts) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
        break;
      } catch (err) {
        lastError = err;
        if (err.name !== "OverconstrainedError") break;
      }
    }
    if (!this.stream) throw lastError;
    this.video.srcObject = this.stream;
    await this.video.play();
    const s = this.stream.getVideoTracks()[0].getSettings();
    this.cameraLabel = this.stream.getVideoTracks()[0].label;
    this.cameraMode = `${s.width}x${s.height}@${Math.round(s.frameRate || 0)}`;
    this.status = "tracking";
    this._schedule();
  }

  stop() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.lastLandmarks = null;
    if (this.status === "tracking" || this.status === "no face") this.status = "off";
  }

  _schedule() {
    if (!this.stream) return;
    this.video.requestVideoFrameCallback((now, meta) => this._onFrame(now, meta));
  }

  _onFrame(now, meta) {
    if (!this.stream) return;
    this._schedule();
    const video = this.video;
    if (!this.landmarker || !video.videoWidth) return;

    // captureTime is on the performance.now() timeline for local cameras.
    let t = meta && meta.captureTime;
    if (!(t > now - 500 && t <= now)) t = now;

    const ts = Math.max(now, this._lastTs + 0.01);
    this._lastTs = ts;
    const t0 = performance.now();
    const result = this.landmarker.detectForVideo(video, ts);
    this.inferMs += 0.1 * (performance.now() - t0 - this.inferMs);

    if (this._lastFrameT) {
      const inst = 1000 / Math.max(now - this._lastFrameT, 1);
      this.fps += 0.1 * (inst - this.fps);
    }
    this._lastFrameT = now;

    const lm = result.faceLandmarks && result.faceLandmarks[0];
    if (!lm) {
      this.lastLandmarks = null;
      this.status = "no face";
      return;
    }
    this.lastLandmarks = lm;
    this.status = "tracking";

    const w = video.videoWidth;
    const h = video.videoHeight;
    const ax = lm[LEFT_IRIS].x * w, ay = lm[LEFT_IRIS].y * h;
    const bx = lm[RIGHT_IRIS].x * w, by = lm[RIGHT_IRIS].y * h;
    const ipdPx = Math.hypot(ax - bx, ay - by);
    if (ipdPx < 2) return;

    // Turning the head foreshortens the eye spacing; undo that using the head
    // rotation so a turn is not mistaken for moving away.
    let yawScale = 1;
    let rot = null;
    const m = result.facialTransformationMatrixes && result.facialTransformationMatrixes[0];
    if (m && m.data) {
      const d = m.data;
      const sx = Math.hypot(d[0], d[1], d[2]) || 1;
      yawScale = Math.min(Math.max(Math.hypot(d[0], d[1]) / sx, 0.5), 1);
      // Which way the face points (its +z axis) and which way its top points
      // (+y), in camera space. Signs are chosen so the angles can be applied
      // directly to a three.js camera: yaw + = left, pitch + = up, roll + = ccw.
      const fz = Math.hypot(d[8], d[9], d[10]) || 1;
      rot = [
        Math.atan2(d[8], d[10]),
        Math.asin(Math.min(Math.max(d[9] / fz, -1), 1)),
        Math.atan2(d[4], d[5]),
      ];
    }
    this.lastIpdPx = ipdPx;
    this.lastYawScale = yawScale;

    const f = this.focalPx();
    const z = (f * this.params.ipdMm * 0.001 * yawScale) / ipdPx;
    const u = (ax + bx) / 2 - w / 2;
    const v = (ay + by) / 2 - h / 2;
    this.onSample([(u / f) * z, (v / f) * z, z], t, rot);
  }

  focalPx() {
    const w = this.video.videoWidth || 640;
    return w / 2 / Math.tan((this.params.camFovDeg * Math.PI) / 360);
  }

  // Solve the camera's horizontal FOV from a known eye-to-camera distance.
  fovForDistance(distanceM) {
    if (!this.lastIpdPx) return null;
    const f = (distanceM * this.lastIpdPx) / (this.params.ipdMm * 0.001 * this.lastYawScale);
    const w = this.video.videoWidth || 640;
    return (2 * Math.atan(w / 2 / f) * 180) / Math.PI;
  }

  drawPreview(canvas, cw = 280) {
    const video = this.video;
    if (!video.videoWidth) return;
    const ch = Math.round((cw * video.videoHeight) / video.videoWidth);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    const g = canvas.getContext("2d");
    // Mirrored, so it reads like a mirror to the person in front of it.
    g.save();
    g.translate(cw, 0);
    g.scale(-1, 1);
    g.drawImage(video, 0, 0, cw, ch);
    const lm = this.lastLandmarks;
    if (lm) {
      g.fillStyle = "#3f8";
      const dot = cw > 400 ? 3 : 2;
      for (let i = 0; i < lm.length; i += 6) g.fillRect(lm[i].x * cw - dot / 2, lm[i].y * ch - dot / 2, dot, dot);
      g.fillStyle = "#f44";
      for (const i of [LEFT_IRIS, RIGHT_IRIS]) {
        g.beginPath();
        g.arc(lm[i].x * cw, lm[i].y * ch, cw > 400 ? 8 : 4, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.restore();
  }
}
