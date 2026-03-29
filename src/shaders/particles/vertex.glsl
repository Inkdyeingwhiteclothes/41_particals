uniform vec2 uResolution;
uniform float uSize;
uniform sampler2D uParticlesTexture;
uniform vec3 uModelCenter;   // 模型边界盒中心
uniform float uShrinkNear;   // 开始缩小的距离
uniform float uShrinkFar;    // 完全缩小的距离
uniform float uShrinkMin;    // 最小缩小比例

varying vec3 vColor;

attribute vec2 aParticlesUv;
attribute vec3 aColor;
attribute float aSize;

void main()
{
    vec4 particle = texture(uParticlesTexture, aParticlesUv);
    // Final position
    vec4 modelPosition = modelMatrix * vec4(particle.xyz, 1.0);
    vec4 viewPosition = viewMatrix * modelPosition;
    vec4 projectedPosition = projectionMatrix * viewPosition;
    gl_Position = projectedPosition;

    // Point size
    float sizeIn = smoothstep(0.0,0.1,particle.a);
    float sizeOut = 1.0-smoothstep(0.5,0.95,particle.a);
    float size = min(sizeIn, sizeOut);

    gl_PointSize = uSize * uResolution.y * aSize * size;
    gl_PointSize *= (1.0 / - viewPosition.z);
    
    // 【远离模型中心时的随机缩小】
    // 计算粒子到模型中心的距离
    float distToCenter = distance(particle.xyz, uModelCenter);
    // distanceFactor: 0.0(近距离) -> 1.0(远距离)
    float distanceFactor = smoothstep(uShrinkNear, uShrinkFar, distToCenter);
    // aSize作为随机因子，让每个粒子缩小程度不同 (uShrinkMin~1.0范围)
    float randomShrink = mix(uShrinkMin, 1.0, aSize);
    // 应用距离缩小：越远离缩小越多，随机变化
    gl_PointSize *= mix(1.0, randomShrink, distanceFactor);
    

    // Varyings
    vColor = aColor;
}