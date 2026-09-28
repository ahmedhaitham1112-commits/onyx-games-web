const flightDuration = 1.65;
const titleFadeStart = 1.82;
const ambientStart = 2.48;

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const randomBetween = (minimum, maximum) => minimum + Math.random() * (maximum - minimum);

export function initializeHeroIntro() {
  const stage = document.querySelector(".hero-art");
  const canvas = stage?.querySelector("[data-hero-canvas]");
  const title = stage?.querySelector("[data-hero-title]");
  if (!stage || !canvas || !title) return;

  const context = canvas.getContext("2d", { alpha: true });
  if (!context) return;

  const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
  let width = 0;
  let height = 0;
  let pixelRatio = 1;
  let elapsed = 0;
  let previousFrame = null;
  let animationFrame = null;
  let inView = false;
  let impacted = false;
  let impactPoint = null;
  let impactDirection = null;
  let chips = [];
  let particles = [];

  function getStone() {
    const scale = Math.min(1, width / 460, height / 300);
    const stoneWidth = 88 * scale;
    const stoneHeight = 100 * scale;
    const ground = height * 0.835;
    return {
      x: width * 0.035,
      y: ground,
      width: stoneWidth,
      height: stoneHeight,
      impactX: width * 0.035 + stoneWidth * 0.96,
      impactY: ground - stoneHeight * 0.61,
    };
  }

  function resizeScene() {
    const bounds = stage.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    width = bounds.width;
    height = bounds.height;
    pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    if (particles.length === 0) createParticles();
    drawScene(motionPreference.matches ? ambientStart : elapsed, 0);
    if (stage.getClientRects().length) startLoop();
  }

  function createParticles() {
    particles = Array.from({ length: 20 }, (_, index) => {
      const size = randomBetween(3, 6.5);
      const x = randomBetween(width * 0.06, width * 0.94);
      return {
        x,
        y: -size - randomBetween(0, height * 0.8),
        startX: x,
        size,
        velocityX: randomBetween(-9, 9),
        velocityY: randomBetween(4, 18),
        rotation: randomBetween(0, Math.PI * 2),
        rotationSpeed: randomBetween(-1.2, 1.2),
        gravity: randomBetween(48, 72),
        activation: ambientStart + (index % 4) * 0.24,
      };
    });
  }

  function flightState(time, stone) {
    const swordLength = Math.min(116, height * 0.34);
    const duration = flightDuration;
    const gravity = height * 0.78;
    const startX = width + swordLength * 0.62;
    const startY = height * 0.12;
    const targetX = stone.impactX;
    const targetY = stone.impactY;
    const velocityX = (targetX - startX) / duration;
    const velocityY = (targetY - startY - 0.5 * gravity * duration * duration) / duration;
    const flightTime = Math.min(time, duration);
    const tipX = startX + velocityX * flightTime;
    const tipY = startY + velocityY * flightTime + 0.5 * gravity * flightTime * flightTime;
    const currentVelocityY = velocityY + gravity * flightTime;
    return {
      tipX,
      tipY,
      velocityX,
      velocityY: currentVelocityY,
      length: swordLength,
      gravity,
      rotationOffset: Math.PI * 8 * (1 - flightTime / duration),
    };
  }

  function drawStone(stone, showChip) {
    const { x, y, width: stoneWidth, height: stoneHeight } = stone;
    const topX = x + stoneWidth * 0.48;
    const points = [
      [topX, y - stoneHeight],
      [x + stoneWidth * 0.94, y - stoneHeight * 0.72],
      [x + stoneWidth, y - stoneHeight * 0.31],
      [x + stoneWidth * 0.78, y - stoneHeight * 0.04],
      [x + stoneWidth * 0.39, y],
      [x + stoneWidth * 0.08, y - stoneHeight * 0.19],
      [x, y - stoneHeight * 0.62],
    ];

    context.save();
    context.fillStyle = "#050409";
    context.shadowColor = "#050409";
    context.shadowBlur = 18;
    context.beginPath();
    context.ellipse(x + stoneWidth * 0.48, y + 3, stoneWidth * 0.72, stoneHeight * 0.12, 0, 0, Math.PI * 2);
    context.fill();
    context.shadowBlur = 0;

    const stoneGradient = context.createLinearGradient(x, y - stoneHeight, x + stoneWidth, y);
    stoneGradient.addColorStop(0, "#d5b4ff");
    stoneGradient.addColorStop(0.34, "#7549b4");
    stoneGradient.addColorStop(0.72, "#241632");
    stoneGradient.addColorStop(1, "#09070d");
    context.beginPath();
    points.forEach(([pointX, pointY], index) => {
      if (index === 0) context.moveTo(pointX, pointY);
      else context.lineTo(pointX, pointY);
    });
    context.closePath();
    context.fillStyle = stoneGradient;
    context.fill();
    context.strokeStyle = "#d5b5ff99";
    context.lineWidth = 1;
    context.stroke();

    context.beginPath();
    context.moveTo(topX, y - stoneHeight);
    context.lineTo(x + stoneWidth * 0.48, y - stoneHeight * 0.48);
    context.lineTo(x + stoneWidth * 0.94, y - stoneHeight * 0.72);
    context.closePath();
    context.fillStyle = "#eadbff38";
    context.fill();

    context.beginPath();
    context.moveTo(x + stoneWidth * 0.48, y - stoneHeight * 0.48);
    context.lineTo(x + stoneWidth * 0.39, y);
    context.lineTo(x + stoneWidth * 0.08, y - stoneHeight * 0.19);
    context.lineTo(x + stoneWidth * 0.48, y - stoneHeight * 0.48);
    context.fillStyle = "#08060d99";
    context.fill();

    if (showChip) {
      context.beginPath();
      context.moveTo(stone.impactX - stoneWidth * 0.03, stone.impactY - stoneHeight * 0.08);
      context.lineTo(x + stoneWidth * 0.71, y - stoneHeight * 0.56);
      context.lineTo(x + stoneWidth * 0.64, y - stoneHeight * 0.45);
      context.lineTo(x + stoneWidth * 0.49, y - stoneHeight * 0.51);
      context.lineTo(x + stoneWidth * 0.34, y - stoneHeight * 0.37);
      context.lineTo(x + stoneWidth * 0.2, y - stoneHeight * 0.42);
      context.moveTo(x + stoneWidth * 0.64, y - stoneHeight * 0.45);
      context.lineTo(x + stoneWidth * 0.59, y - stoneHeight * 0.29);
      context.lineTo(x + stoneWidth * 0.47, y - stoneHeight * 0.2);
      context.moveTo(x + stoneWidth * 0.49, y - stoneHeight * 0.51);
      context.lineTo(x + stoneWidth * 0.45, y - stoneHeight * 0.67);
      context.lineTo(x + stoneWidth * 0.34, y - stoneHeight * 0.74);
      context.lineJoin = "round";
      context.strokeStyle = "#080611";
      context.lineWidth = 4;
      context.stroke();
      context.strokeStyle = "#e6d4ff";
      context.lineWidth = 1.5;
      context.stroke();
    }
    context.restore();
  }

  function drawSword(tipX, tipY, velocityX, velocityY, length, alpha = 1, rotationOffset = 0) {
    const speed = Math.hypot(velocityX, velocityY) || 1;
    const directionX = velocityX / speed;
    const directionY = velocityY / speed;
    const angle = Math.atan2(velocityY, velocityX) + Math.PI / 2 + rotationOffset;
    const centerX = tipX - directionX * length * 0.48;
    const centerY = tipY - directionY * length * 0.48;
    const scale = length / 116;

    context.save();
    context.globalAlpha = alpha;
    context.translate(centerX, centerY);
    context.rotate(angle);
    context.shadowColor = "#a66bea";
    context.shadowBlur = 10 * scale;

    const blade = context.createLinearGradient(-10 * scale, -length * 0.48, 10 * scale, length * 0.12);
    blade.addColorStop(0, "#f1e4ff");
    blade.addColorStop(0.38, "#a77be1");
    blade.addColorStop(1, "#24152f");
    context.beginPath();
    context.moveTo(0, -length * 0.49);
    context.lineTo(10 * scale, length * 0.08);
    context.lineTo(0, length * 0.16);
    context.lineTo(-10 * scale, length * 0.08);
    context.closePath();
    context.fillStyle = blade;
    context.fill();
    context.strokeStyle = "#e6d5ff";
    context.lineWidth = 1.25 * scale;
    context.stroke();

    context.shadowBlur = 0;
    context.beginPath();
    context.moveTo(-19 * scale, length * 0.13);
    context.lineTo(19 * scale, length * 0.13);
    context.lineTo(15 * scale, length * 0.2);
    context.lineTo(-15 * scale, length * 0.2);
    context.closePath();
    context.fillStyle = "#8b5cc1";
    context.fill();
    context.strokeStyle = "#cbaaff";
    context.stroke();

    context.beginPath();
    context.moveTo(0, length * 0.19);
    context.lineTo(0, length * 0.43);
    context.strokeStyle = "#21162c";
    context.lineWidth = 8 * scale;
    context.stroke();
    context.strokeStyle = "#9869cd";
    context.lineWidth = 5 * scale;
    context.stroke();
    context.beginPath();
    context.arc(0, length * 0.44, 4 * scale, 0, Math.PI * 2);
    context.fillStyle = "#d8c2fa";
    context.fill();
    context.restore();
    return { directionX, directionY };
  }

  function createImpactChips(stone) {
    impactPoint = { x: stone.impactX, y: stone.impactY };
    const flight = flightState(flightDuration, stone);
    const speed = Math.hypot(flight.velocityX, flight.velocityY) || 1;
    impactDirection = { x: flight.velocityX / speed, y: flight.velocityY / speed };
    chips = Array.from({ length: 8 }, () => {
      const angle = randomBetween(-Math.PI * 0.82, Math.PI * 0.82);
      const speedValue = randomBetween(28, 104);
      return {
        x: impactPoint.x,
        y: impactPoint.y,
        velocityX: Math.cos(angle) * speedValue,
        velocityY: Math.sin(angle) * speedValue - randomBetween(12, 48),
        size: randomBetween(2, 4.5),
        rotation: randomBetween(0, Math.PI * 2),
        rotationSpeed: randomBetween(-7, 7),
      };
    });
  }

  function updateAndDrawParticles(deltaTime, time) {
    if (time < ambientStart) return;
    particles.forEach((particle) => {
      if (time < particle.activation) return;
      particle.velocityY += particle.gravity * deltaTime;
      particle.x += particle.velocityX * deltaTime;
      particle.y += particle.velocityY * deltaTime;
      particle.rotation += particle.rotationSpeed * deltaTime;

      if (particle.y > height + particle.size * 2 || particle.x < -30 || particle.x > width + 30) {
        particle.x = particle.startX;
        particle.y = -particle.size - randomBetween(0, height * 0.22);
        particle.velocityX = randomBetween(-9, 9);
        particle.velocityY = randomBetween(4, 18);
      }
      drawShard(particle.x, particle.y, particle.size, particle.rotation, 1);
    });
  }

  function drawShard(x, y, size, rotation, alpha) {
    context.save();
    context.globalAlpha = alpha;
    context.translate(x, y);
    context.rotate(rotation);
    context.shadowColor = "#a87ae2";
    context.shadowBlur = size * 1.4;
    context.beginPath();
    context.moveTo(0, -size);
    context.lineTo(size * 0.62, -size * 0.12);
    context.lineTo(size * 0.18, size * 1.1);
    context.lineTo(-size * 0.72, size * 0.38);
    context.closePath();
    const shardGradient = context.createLinearGradient(-size, -size, size, size);
    shardGradient.addColorStop(0, "#f0deff");
    shardGradient.addColorStop(0.45, "#9569cf");
    shardGradient.addColorStop(1, "#17101f");
    context.fillStyle = shardGradient;
    context.fill();
    context.restore();
  }

  function drawScene(time, deltaTime) {
    if (!width || !height) return;
    context.clearRect(0, 0, width, height);
    const stone = getStone();
    const hasImpacted = time >= flightDuration;
    if (hasImpacted && !impacted) {
      impacted = true;
      createImpactChips(stone);
    }

    drawStone(stone, hasImpacted);
    const flight = flightState(time, stone);
    if (hasImpacted) {
      const embedDepth = flight.length * 0.325;
      const tipX = stone.impactX + impactDirection.x * embedDepth;
      const tipY = stone.impactY + impactDirection.y * embedDepth;
      drawSword(tipX, tipY, impactDirection.x, impactDirection.y, flight.length);
    } else {
      drawSword(flight.tipX, flight.tipY, flight.velocityX, flight.velocityY, flight.length, 1, flight.rotationOffset);
    }

    const impactAge = Math.max(0, time - flightDuration);
    chips.forEach((chip) => {
      if (impactAge > 0.72) return;
      chip.velocityY += 190 * deltaTime;
      chip.x += chip.velocityX * deltaTime;
      chip.y += chip.velocityY * deltaTime;
      chip.rotation += chip.rotationSpeed * deltaTime;
      drawShard(chip.x, chip.y, chip.size, chip.rotation, 1 - impactAge / 0.72);
    });

    const titleOpacity = motionPreference.matches ? 1 : clamp((time - titleFadeStart) / 0.62, 0, 1);
    title.style.opacity = String(titleOpacity);
    updateAndDrawParticles(deltaTime, time);
  }

  function animate(timestamp) {
    animationFrame = null;
    if (!inView || document.visibilityState === "hidden") return;
    if (previousFrame === null) previousFrame = timestamp;
    const deltaTime = Math.min((timestamp - previousFrame) / 1000, 1 / 30);
    previousFrame = timestamp;
    if (!motionPreference.matches) elapsed += deltaTime;
    drawScene(motionPreference.matches ? ambientStart : elapsed, deltaTime);
    animationFrame = window.requestAnimationFrame(animate);
  }

  function startLoop() {
    if (!width || !height || !inView || document.visibilityState === "hidden") return;
    if (motionPreference.matches) {
      drawScene(ambientStart, 0);
      return;
    }
    if (animationFrame === null) {
      previousFrame = null;
      animationFrame = window.requestAnimationFrame(animate);
    }
  }

  function stopLoop() {
    if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
    animationFrame = null;
    previousFrame = null;
  }

  const intersectionObserver = new IntersectionObserver(([entry]) => {
    inView = entry.isIntersecting;
    if (inView) startLoop();
    else stopLoop();
  });
  intersectionObserver.observe(stage);

  const resizeObserver = new ResizeObserver(resizeScene);
  resizeObserver.observe(stage);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") stopLoop();
    else startLoop();
  });
  motionPreference.addEventListener("change", () => {
    if (motionPreference.matches) {
      stopLoop();
      drawScene(ambientStart, 0);
    } else {
      startLoop();
    }
  });
}