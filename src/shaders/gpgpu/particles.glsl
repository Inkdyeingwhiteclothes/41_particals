uniform float uTime;
uniform sampler2D uBase;
uniform float uDeltaTime;
uniform float uFlowFieldInfluence;
uniform float uFlowFieldStrength;
uniform float uFlowFieldFrequency;
uniform sampler2D uDisplacementTexture;
uniform float uDisplacementStrength;
uniform float uDisplacementSpread;
uniform float uDisplacementZScale;
uniform vec3 uCameraPosition;
uniform float uDisplacementEnabled;
uniform float uDisplacementSpeed;

#include ../includes/simplexNoise4d.glsl

void main() {
    float time = uTime * 0.2;
    
    // 【UV坐标计算】
    // gl_FragCoord.xy: 当前像素在纹理中的坐标（如128x128纹理中的(10, 20)）
    // resolution.xy: 纹理的总尺寸（如128, 128）
    // uv = (0~1范围): 归一化的UV坐标，对应粒子在纹理中的位置
    // 每个像素处理一个粒子，UV就是这个粒子的"身份证"
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    
    // 从uParticles纹理中采样当前粒子的位置和生命周期
    // 该纹理在GPGPU计算中每帧更新
    vec4 particle = texture(uParticles, uv);
    
    // uBase纹理存储粒子的初始位置（来自模型几何体）
    vec4 base = texture(uBase, uv);

    // 【Displacement映射 - 核心逻辑】
    // 用当前粒子的UV坐标去采样displacement纹理
    // displacement纹理是一个2D canvas，鼠标位置会在上面绘制glow
    // 如果鼠标在这个UV位置附近，displacementIntensity就会 > 0
    float displacementIntensity = texture(uDisplacementTexture, uv).r;
    // smoothstep: 将强度平滑映射到0.1-0.3范围，低于0.1的设为0
    displacementIntensity = smoothstep(0.1, 0.3, displacementIntensity);
    
    // 【朝向相机的分散式抬起计算】
    // 仅在uDisplacementEnabled=1.0时启用光标互动
    vec3 displacement = vec3(0.0);
    
    if (uDisplacementEnabled > 0.5) {
        // 从base.w获取随机角度(0-2π)，用于在相机周围散开
        float aAngle = base.a;
        
        // 计算从粒子指向相机的方向向量
        vec3 toCamera = uCameraPosition - particle.xyz;
        vec3 cameraDir = normalize(toCamera);
        
        // 创建一个垂直于相机方向的随机偏移
        // 使用随机角度计算xy平面的偏移
        vec3 spreadOffset = vec3(
            cos(aAngle) * uDisplacementSpread,
            sin(aAngle) * uDisplacementSpread,
            0.0
        );
        
        // 将基础相机方向与随机偏移结合
        // 先让相机方向有向上的分量，再添加径向散开
        displacement = cameraDir * uDisplacementZScale + spreadOffset;
        displacement = normalize(displacement);
        displacement *= displacementIntensity * uDisplacementStrength;
    }

    // Dead
    if (particle.a >= 1.0) {
        particle.a = mod(particle.a,1.0);
        particle.xyz = base.xyz;
    }

    // Alive
    else{
        // Strength
        float strength = simplexNoise4d(vec4(particle.xyz*0.2, time+1.0));
        float influence = (uFlowFieldInfluence - 0.5) * (-2.0);
        strength = smoothstep(influence, 1.0, strength);
            
        // Flow field
        vec3 flowField = vec3(
            simplexNoise4d(vec4(particle.xyz * uFlowFieldFrequency, time)),
            simplexNoise4d(vec4(particle.xyz + 1.0 * uFlowFieldFrequency, time)),
            simplexNoise4d(vec4(particle.xyz + 2.0 * uFlowFieldFrequency, time))
        );
        flowField = normalize(flowField);
        particle.xyz += flowField * uDeltaTime * strength * uFlowFieldStrength;

        // Apply displacement (抬起效果)
        particle.xyz += displacement * uDeltaTime * uDisplacementSpeed;

        particle.a += uDeltaTime * 0.3;
    }

    
    
    gl_FragColor = particle;
}