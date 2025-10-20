let posePlayer;
let headImg; // Head image

const fps = 30;
const poseWidth = 640;
const poseHeight = 480;

// Skeleton edges
const skeletonEdges = [
  [5, 7], [7, 9], [6, 8], [8, 10],
  [11, 13], [13, 15], [12, 14], [14, 16],
  [5, 6], [11, 12], [5, 11], [6, 12]
];

function preload() {
  posePlayer = new PosePlayer('bncbc.mp4', 'retro-kannadi-poo.json');
  headImg = loadImage('head.png'); // Load head image
}

function setup() {
  createCanvas(1280, 720);
  frameRate(fps);
  posePlayer.setup();
}

function draw() {
  background(0);
  posePlayer.update();
  posePlayer.display();
}

function keyPressed() {
  posePlayer.handleKey(key.toUpperCase());
}

// ---------------- PosePlayer Class ----------------
class PosePlayer {
  constructor(videoFile, poseJSONFile) {
    this.videoFile = videoFile;
    this.poseJSONFile = poseJSONFile;

    this.poseMap = {};
    this.video = null;
    this.poseTime = 0;
    this.playing = false;
    this.showPose = true;
    this.playbackRate = 1;

    this.scaleCycle = [1, 0.75, 0.5, 0.25];
    this.scaleIndex = 0;
    this.scaleFactor = 1;

    this.pointSizeCycle = [6, 12, 18, 24, 36];
    this.pointSizeIndex = 1;
    this.pointSize = this.pointSizeCycle[this.pointSizeIndex];
    this.headSize = 150; // size of head image

    this.offsetX = 0;
    this.offsetY = 0;
    this.isDragging = false;
    this.dragStartX = 0;
    this.dragStartY = 0;

    this.speedInput = null;
    this.isLoaded = false;

    // transparency controls
    this.alpha = 120; // 0..255
    this.alphaSlider = null;

    this._lastVideoW = null;
    this._lastVideoH = null;

    // ===== Trails (loci) =====
    this.trails = {};
    this.showTrails = true;
    this.maxTrailLen = 240; // ~8s @30 fps
    this.trailAlpha = 160;
    this.trailWeight = 3;
    this.trailColors = [
      [0, 200, 255],
      [255, 80, 0],
      [0, 255, 120],
      [255, 200, 0],
      [180, 120, 255],
      [255, 0, 180]
    ];

    // ===== Ground & normal reaction =====
    // Ground stored in *video coordinate space* (0..poseHeight)
    this.groundY = poseHeight * 0.92; // default near bottom
    this.showGround = true;

    // Contact detection (in video coords per frame)
    this.contactTolY = 8;     // max distance from ground (px)
    this.velThresh = 0.8;     // |vy| below this => "nearly stationary" (px/frame)
    this.reactScale = 40;     // scales the arrow length on screen
    this.showNormals = true;

    // previous frame keypoints for velocity computation
    // prevKpts[personIdx][kpIdx] = {x,y}
    this.prevKpts = {};

    // store DOM controls so we can manage them
    this.controls = [];
  }

  setup() {
    this.loadJSONData();
    this.loadVideo();
    this.setupControls();
  }

  // load pose JSON -> poseMap[frame] = [kptsPerson0, kptsPerson1, ...]
  loadJSONData() {
    loadJSON(this.poseJSONFile, data => {
      this.preparePoseMap(data);
      this.checkIfLoaded();
    }, err => console.error("Failed to load JSON:", err));
  }

  loadVideo() {
    this.video = createVideo([this.videoFile], () => {
      this.video.hide();
      this.video.volume(0);
      this.video.elt.muted = true;
      this.video.speed(this.playbackRate);
      this.checkIfLoaded();
    }, err => console.error("Failed to load video:", err));
  }

  checkIfLoaded() {
    if (this.video && Object.keys(this.poseMap).length > 0) {
      this.isLoaded = true;
      this.play();
    }
  }

  preparePoseMap(data) {
    const entries = Array.isArray(data) ? data : Object.values(data);
    entries.forEach(entry => {
      const frameId = Number(entry.frame_id);
      if (!this.poseMap[frameId]) this.poseMap[frameId] = [];
      this.poseMap[frameId].push(entry.keypoints);
    });
  }

  // Update time and trails. Do NOT overwrite prevKpts here; prevKpts should remain from previous frame
  update() {
    if (!this.isLoaded || !this.playing) return;

    this.poseTime += (deltaTime / 1000) * this.playbackRate;

    if (this.video && this.video.elt.readyState >= 2) {
      const dur = this.video.elt.duration || Infinity;
      if (this.poseTime >= dur) {
        this.poseTime = dur;
        this.stop();
      } else if (abs(this.video.time() - this.poseTime) > 0.1) {
        this.video.time(this.poseTime);
      }
    }

    const lastFrameNum = Math.max(...Object.keys(this.poseMap).map(Number));
    const lastTime = lastFrameNum / fps;
    if (this.poseTime >= lastTime) this.stop();

    // trails (uses current frame)
    this._updateTrails();
    // Note: prevKpts is updated at the end of display() so velocity compares current->previous correctly.
  }

  display() {
    if (!this.isLoaded) {
      this.showLoading();
      return;
    }

    const videoAspect = poseWidth / poseHeight;
    const targetHeight = height;
    const targetWidth = targetHeight * videoAspect;

    this._lastVideoW = targetWidth;
    this._lastVideoH = targetHeight;

    if (this.video && this.video.elt.readyState >= 2) {
      image(this.video, 0, 0, targetWidth, targetHeight);
    }

    if (this.showGround) this._drawGround(targetWidth, targetHeight);
    if (this.showTrails) this._drawTrails(targetWidth, targetHeight);
    if (this.showPose) this.drawPoseOverlayToCanvas(targetWidth, targetHeight);
    if (this.showNormals) this._drawFootNormals(targetWidth, targetHeight);

    // Save current frame keypoints to prevKpts for next frame velocity calculation
    this._savePrevKpts();
  }

  showLoading() {
    push();
    textSize(36);
    fill(255);
    textAlign(CENTER, CENTER);
    text('Loading...', width / 2, height / 2);
    pop();
  }

  drawPoseOverlayToCanvas(videoW, videoH) {
    this._drawPoseOverlay(drawingContext, videoW, videoH);
  }

  _drawPoseOverlay(ctx, videoW, videoH) {
    const frameIndex = floor(this.poseTime * fps);
    const persons = this.poseMap[frameIndex] || [];

    push();
    translate(this.offsetX, this.offsetY);
    scale(this.scaleFactor);

    const scaleX = videoW / poseWidth;
    const scaleY = videoH / poseHeight;

    const edgeAlpha = this.alpha;
    const pointAlpha = this.alpha;
    const labelAlpha = max(90, this.alpha - 30);

    persons.forEach(kpts => {
      // Skeleton
      skeletonEdges.forEach(([i, j]) => {
        const a = kpts[i], b = kpts[j];
        if (a && b) {
          stroke(255, 255, 0, edgeAlpha);
          strokeWeight(max(3, 4 / this.scaleFactor));
          line(a[0] * scaleX, a[1] * scaleY, b[0] * scaleX, b[1] * scaleY);
        }
      });

      // Keypoints + labels
      noStroke();
      fill(255, 0, 0, pointAlpha);
      kpts.forEach((p, idx) => {
        if (!p) return;
        const x = p[0] * scaleX;
        const y = p[1] * scaleY;
        ellipse(x, y, this.pointSize);

        fill(255, 255, 255, labelAlpha);
        textAlign(CENTER, CENTER);
        textSize(max(10, 14 / this.scaleFactor));
        text(idx.toString(), x, y - this.pointSize);

        if (idx === 0 && headImg) {
          push();
          tint(255, this.alpha);
          imageMode(CENTER);
          const scaledHeadSize = this.headSize * this.scaleFactor;
          image(headImg, x, y - scaledHeadSize / 2, scaledHeadSize, scaledHeadSize);
          pop();
        }
      });
    });

    pop();
  }

  // ===== Trails =====
  _updateTrails() {
    const frameIndex = floor(this.poseTime * fps);
    const persons = this.poseMap[frameIndex] || [];

    for (let pi = 0; pi < persons.length; pi++) {
      if (!this.trails[pi]) this.trails[pi] = {};
      const kpts = persons[pi];
      for (let ki = 0; ki < kpts.length; ki++) {
        if (!this.trails[pi][ki]) this.trails[pi][ki] = [];
        const p = kpts[ki];
        if (p) {
          this.trails[pi][ki].push({ x: p[0], y: p[1] });
          if (this.trails[pi][ki].length > this.maxTrailLen) {
            this.trails[pi][ki].shift();
          }
        }
      }
    }
  }

  _drawTrails(videoW, videoH) {
    push();
    translate(this.offsetX, this.offsetY);
    scale(this.scaleFactor);

    const scaleX = videoW / poseWidth;
    const scaleY = videoH / poseHeight;

    const baseW = max(1.5, this.trailWeight / this.scaleFactor);

    Object.keys(this.trails).forEach(piStr => {
      const pi = Number(piStr);
      const [r, g, b] = this.trailColors[pi % this.trailColors.length];

      Object.keys(this.trails[pi]).forEach(kiStr => {
        const pts = this.trails[pi][kiStr];
        if (!pts || pts.length < 2) return;

        for (let s = 1; s < pts.length; s++) {
          const t = s / pts.length; // 0..1
          const a = lerp(40, this.trailAlpha, t); // fade head->tail
          stroke(r, g, b, a);
          strokeWeight(baseW);
          noFill();

          beginShape();
          const p0 = pts[max(0, s - 2)];
          const p1 = pts[s - 1];
          const p2 = pts[s];
          const p3 = pts[min(pts.length - 1, s + 1)];

          curveVertex(p0.x * scaleX, p0.y * scaleY);
          curveVertex(p1.x * scaleX, p1.y * scaleY);
          curveVertex(p2.x * scaleX, p2.y * scaleY);
          curveVertex(p3.x * scaleX, p3.y * scaleY);
          endShape();
        }
      });
    });

    pop();
  }

  // ===== Ground line (video coords -> screen) =====
  _drawGround(videoW, videoH) {
    push();
    translate(this.offsetX, this.offsetY);
    scale(this.scaleFactor);

    const scaleY = videoH / poseHeight;

    stroke(0, 255, 255, 140);
    strokeWeight(max(2, 2.5 / this.scaleFactor));
    const gy = this.groundY * scaleY;
    line(0, gy, videoW, gy);

    noStroke();
    fill(200, 255, 255, 140);
    textSize(max(10, 14 / this.scaleFactor));
    textAlign(LEFT, BOTTOM);
    text('Ground', 10, gy - 6);

    pop();
  }

  // ===== Foot normals & contact detection =====
  _drawFootNormals(videoW, videoH) {
    const frameIndex = floor(this.poseTime * fps);
    const persons = this.poseMap[frameIndex] || [];

    const scaleX = videoW / poseWidth;
    const scaleY = videoH / poseHeight;

    // screen helpers
    const toScreen = (vx, vy) => {
      return {
        x: (vx * scaleX) * this.scaleFactor + this.offsetX,
        y: (vy * scaleY) * this.scaleFactor + this.offsetY
      };
    };

    // for each person, check ankles 15 (L) and 16 (R)
    for (let pi = 0; pi < persons.length; pi++) {
      const kpts = persons[pi];
      [15, 16].forEach(kp => {
        const p = kpts[kp];
        if (!p) return;

        // velocity from prev frame in video coords (px/frame)
        const last = this.prevKpts[pi]?.[kp];
        let vy = 0;
        if (last) vy = p[1] - last.y; // +ve downward

        const nearGround = Math.abs(p[1] - this.groundY) <= this.contactTolY;
        const slowVert = Math.abs(vy) <= this.velThresh;

        // contact if near ground and vertical speed small
        const inContact = nearGround && slowVert;

        // draw highlight on ankle
        const scr = toScreen(p[0], p[1]);
        push();
        noStroke();
        if (inContact) fill(0, 255, 0, 220); else fill(255, 120, 0, 200);
        ellipse(scr.x, scr.y, max(10, this.pointSize * 1.2));
        pop();

        if (inContact) {
          const L = this.reactScale * (1 + (this.contactTolY - Math.abs(p[1] - this.groundY)) / (this.contactTolY + 0.001));
          const tip = toScreen(p[0], p[1] - (L / scaleY) / this.scaleFactor);
          this._drawArrow(scr.x, scr.y, tip.x, tip.y, 'N');
        }
      });
    }
  }

  _drawArrow(x1, y1, x2, y2, label = '') {
    push();
    stroke(80, 255, 80, 230);
    strokeWeight(3);
    line(x1, y1, x2, y2);

    // arrowhead
    const ang = atan2(y2 - y1, x2 - x1);
    const ah = 12;
    push();
    translate(x2, y2);
    rotate(ang);
    line(0, 0, -ah, -ah * 0.6);
    line(0, 0, -ah, +ah * 0.6);
    pop();

    // label
    noStroke();
    fill(220);
    textSize(16);
    textAlign(LEFT, BOTTOM);
    push();
    translate(x2, y2);
    rotate(ang);
    rotate(-ang); // ensure label not rotated (simpler)
    text(label, 6, -6);
    pop();
    pop();
  }

  // Save current frame keypoints to prevKpts (used on next frame)
  _savePrevKpts() {
    const frameIndex = floor(this.poseTime * fps);
    const persons = this.poseMap[frameIndex] || [];
    const copy = {};
    for (let pi = 0; pi < persons.length; pi++) {
      copy[pi] = {};
      const kpts = persons[pi];
      for (let ki = 0; ki < kpts.length; ki++) {
        const p = kpts[ki];
        if (p) copy[pi][ki] = { x: p[0], y: p[1] };
      }
    }
    this.prevKpts = copy;
  }

  // --------- Controls (OOP-managed) ----------
  setupControls() {
    // remove any old controls (safe)
    this.removeControls();

    const yBase = height - 60;
    // small helper to store controls for removal later
    const store = el => { this.controls.push(el); return el; };

    store(createButton('Play').position(20, yBase).mousePressed(() => this.play()));
    store(createButton('Pause').position(100, yBase).mousePressed(() => this.pause()));
    store(createButton('Stop').position(180, yBase).mousePressed(() => this.stop()));
    store(createButton('Scale').position(260, yBase).mousePressed(() => this.cycleScale()));
    createSpan(' Speed:').position(340, yBase + 5);
    this.speedInput = store(createInput('1.0').position(400, yBase).size(50));
    this.speedInput.input(() => this.setSpeed());

    createSpan('  Alpha:').position(470, yBase + 5);
    this.alphaSlider = store(createSlider(0, 255, this.alpha, 1).position(530, yBase).size(100));
    this.alphaSlider.input(() => { this.alpha = this.alphaSlider.value(); });

    // Trails controls
    store(createButton('Toggle Trails').position(640, yBase).mousePressed(() => this.showTrails = !this.showTrails));
    store(createButton('Clear Trails').position(750, yBase).mousePressed(() => this.clearTrails()));

    createSpan(' Len:').position(860, yBase + 5);
    this.lenSlider = store(createSlider(10, 1200, this.maxTrailLen, 1).position(900, yBase).size(120));
    this.lenSlider.input(() => { this.maxTrailLen = this.lenSlider.value(); });

    createSpan(' Thick:').position(1030, yBase + 5);
    this.wSlider = store(createSlider(1, 10, this.trailWeight, 0.5).position(1080, yBase).size(80));
    this.wSlider.input(() => { this.trailWeight = this.wSlider.value(); });

    // ===== Ground & Normals UI =====
    const line2 = yBase - 30;

    store(createButton('Toggle Ground').position(20, line2).mousePressed(() => this.showGround = !this.showGround));
    createSpan(' Ground Y:').position(130, line2 + 5);
    this.groundSlider = store(createSlider(0, poseHeight, this.groundY, 1).position(210, line2).size(140));
    this.groundSlider.input(() => this.groundY = this.groundSlider.value());

    store(createButton('Toggle Normals').position(370, line2).mousePressed(() => this.showNormals = !this.showNormals));

    createSpan(' TolY:').position(490, line2 + 5);
    this.tolSlider = store(createSlider(1, 30, this.contactTolY, 1).position(530, line2).size(100));
    this.tolSlider.input(() => this.contactTolY = this.tolSlider.value());

    createSpan(' |Vy|≤').position(640, line2 + 5);
    this.velSlider = store(createSlider(0, 5, this.velThresh, 0.1).position(690, line2).size(120));
    this.velSlider.input(() => this.velThresh = this.velSlider.value());

    createSpan(' N scale:').position(820, line2 + 5);
    this.nSlider = store(createSlider(10, 120, this.reactScale, 1).position(890, line2).size(140));
    this.nSlider.input(() => this.reactScale = this.nSlider.value());
  }

  // Remove all controls created earlier
  removeControls() {
    for (const el of this.controls) {
      if (el && el.remove) el.remove();
    }
    this.controls = [];
    // also remove specific refs (safe guard)
    this.speedInput = null;
    this.alphaSlider = null;
    this.lenSlider = null;
    this.wSlider = null;
    this.groundSlider = null;
    this.tolSlider = null;
    this.velSlider = null;
    this.nSlider = null;
  }

  clearTrails() {
    this.trails = {};
  }

  cycleScale() {
    this.scaleIndex = (this.scaleIndex + 1) % this.scaleCycle.length;
    this.scaleFactor = this.scaleCycle[this.scaleIndex];
    this.pointSizeIndex = (this.pointSizeIndex + 1) % this.pointSizeCycle.length;
    this.pointSize = this.pointSizeCycle[this.pointSizeIndex];
  }

  setSpeed() {
    const val = parseFloat(this.speedInput.value());
    this.playbackRate = isNaN(val) ? 1 : val;
    if (this.video) this.video.speed(this.playbackRate);
  }

  play() {
    this.playing = true;
    if (this.video && this.video.elt.readyState >= 2) {
      this.video.play();
      this.video.speed(this.playbackRate);
    }
  }

  pause() {
    this.playing = false;
    if (this.video) this.video.pause();
  }

  stop() {
    this.playing = false;
    this.poseTime = 0;
    if (this.video) {
      this.video.pause();
      this.video.time(0);
    }
    // keep trails/prevKpts for debugging / inspection
  }

  handleKey(k) {
    if (k === 'T') this.showPose = !this.showPose;
    if (k === 'P') this.playing ? this.pause() : this.play();
  }

  mousePressed() {
    if (this.showPose || this.showTrails || this.showGround) {
      this.isDragging = true;
      this.dragStartX = mouseX - this.offsetX;
      this.dragStartY = mouseY - this.offsetY;
    }
  }

  mouseDragged() {
    if (this.isDragging) {
      this.offsetX = mouseX - this.dragStartX;
      this.offsetY = mouseY - this.dragStartY;
    }
  }

  mouseReleased() {
    this.isDragging = false;
  }
}

// Global mouse events
function mousePressed() { posePlayer.mousePressed(); }
function mouseDragged() { posePlayer.mouseDragged(); }
function mouseReleased() { posePlayer.mouseReleased(); }
