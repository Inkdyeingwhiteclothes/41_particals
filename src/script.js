import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import GUI from 'lil-gui'
import particlesVertexShader from './shaders/particles/vertex.glsl'
import particlesFragmentShader from './shaders/particles/fragment.glsl'
import { GPUComputationRenderer } from 'three/addons/misc/GPUComputationRenderer.js'
import gpgpuParticlesShader from './shaders/gpgpu/particles.glsl'

/**
 * Base
 */
// Debug
const gui = new GUI({ width: 340 })
const debugObject = {}

// Canvas
const canvas = document.querySelector('canvas.webgl')

// Scene
const scene = new THREE.Scene()

// Loaders
const dracoLoader = new DRACOLoader()
dracoLoader.setDecoderPath('/draco/')

const gltfLoader = new GLTFLoader()
gltfLoader.setDRACOLoader(dracoLoader)

/**
 * Sizes
 */
const sizes = {
    width: window.innerWidth,
    height: window.innerHeight,
    pixelRatio: Math.min(window.devicePixelRatio, 2)
}

window.addEventListener('resize', () =>
{
    // Update sizes
    sizes.width = window.innerWidth
    sizes.height = window.innerHeight
    sizes.pixelRatio = Math.min(window.devicePixelRatio, 2)

    // Materials
    particles.material.uniforms.uResolution.value.set(sizes.width * sizes.pixelRatio, sizes.height * sizes.pixelRatio)

    // Update camera
    camera.aspect = sizes.width / sizes.height
    camera.updateProjectionMatrix()

    // Update renderer
    renderer.setSize(sizes.width, sizes.height)
    renderer.setPixelRatio(sizes.pixelRatio)
})

/**
 * Camera
 */
// Base camera
const camera = new THREE.PerspectiveCamera(35, sizes.width / sizes.height, 0.1, 100)
camera.position.set(4.5, 4, 11)
scene.add(camera)

// Controls
const controls = new OrbitControls(camera, canvas)
controls.enableDamping = true

/**
 * Renderer
 */
const renderer = new THREE.WebGLRenderer({
    canvas: canvas,
    antialias: true,
})
renderer.setSize(sizes.width, sizes.height)
renderer.setPixelRatio(sizes.pixelRatio)

debugObject.clearColor = '#29191f'
renderer.setClearColor(debugObject.clearColor)

/**
 * Load models
 */
const gltf = await gltfLoader.loadAsync('./model.glb')

/**
 *  Base geometry
 */
const baseGeometry = {}
baseGeometry.instance = gltf.scene.children[0].geometry
baseGeometry.count = baseGeometry.instance.attributes.position.count

// 计算模型边界盒中心
baseGeometry.instance.computeBoundingBox()
const modelCenter = new THREE.Vector3()
baseGeometry.instance.boundingBox.getCenter(modelCenter)

/**
 * Displacement
 */
const displacement = {}

// 2D canvas
displacement.canvas = document.createElement('canvas')
displacement.canvas.width = 128
displacement.canvas.height = 128
displacement.canvas.style.position = 'fixed'
displacement.canvas.style.width = '128px'
displacement.canvas.style.height = '128px'
displacement.canvas.style.top = '0'
displacement.canvas.style.left = '0'
displacement.canvas.style.zIndex = '10'
displacement.canvas.style.pointerEvents = 'none'
document.body.append(displacement.canvas)

// Context
displacement.context = displacement.canvas.getContext('2d')
displacement.context.fillStyle = '#000000'
displacement.context.fillRect(0, 0, displacement.canvas.width, displacement.canvas.height)

// Glow image
displacement.glowImage = new Image()
displacement.glowImage.src = './glow.png'

// Interactive plane - 覆盖粒子所在的区域
displacement.interactivePlane = new THREE.Mesh(
    new THREE.PlaneGeometry(10, 10),
    new THREE.MeshBasicMaterial({ 
        color: 'red', 
        side: THREE.DoubleSide, 
        transparent: true,
        opacity: 0.3,
        visible: false
    })
)
displacement.interactivePlane.position.copy(modelCenter) // 使用实际模型中心
displacement.interactivePlane.visible = true
scene.add(displacement.interactivePlane)

// Raycaster
displacement.raycaster = new THREE.Raycaster()

// Coordinates
displacement.screenCursor = new THREE.Vector2(9999, 9999)
displacement.canvasCursor = new THREE.Vector2(9999, 9999)
displacement.canvasCursorPrevious = new THREE.Vector2(9999, 9999)

window.addEventListener('pointermove', (event) => {
    displacement.screenCursor.x = (event.clientX / sizes.width) * 2 - 1
    displacement.screenCursor.y = -(event.clientY / sizes.height) * 2 + 1
})

displacement.texture = new THREE.CanvasTexture(displacement.canvas)

/**
 * GPU Compute
 * 
 * 【UV映射原理】
 * GPGPU使用一个正方形纹理来存储所有粒子的位置数据。
 * 每个像素对应一个粒子，像素的xy坐标(gl_FragCoord.xy)就是粒子的UV坐标。
 * 例如：gpgpu.size=128 时，纹理是128x128像素，可以存储16384个粒子。
 * 粒子索引 i 对应的UV位置：(i % gpgpu.size, Math.floor(i / gpgpu.size))
 */
// Set up
const gpgpu = {}
// 计算纹理尺寸：需要能容纳所有粒子的最小正方形
// 例如10000个粒子 -> size=100, 纹理100x100=10000像素
gpgpu.size = Math.ceil(Math.sqrt(baseGeometry.count))
gpgpu.computation = new GPUComputationRenderer(gpgpu.size, gpgpu.size, renderer)

// Base particle position texture
const baseParticlePositionTexture = gpgpu.computation.createTexture()

for (let i = 0; i < baseGeometry.count; i++) {
    const i3 = i * 3
    const i4 = i * 4   

    // Postion based on geometry
    baseParticlePositionTexture.image.data[i4] = baseGeometry.instance.attributes.position.array[i3]
    baseParticlePositionTexture.image.data[i4 + 1] = baseGeometry.instance.attributes.position.array[i3 + 1]
    baseParticlePositionTexture.image.data[i4 + 2] = baseGeometry.instance.attributes.position.array[i3 + 2]
    // 存储随机角度(0-2π)，用于displacement计算时分散抬起方向
    baseParticlePositionTexture.image.data[i4 + 3] = Math.random() * Math.PI * 2.0
}

// Particles variable
// 将粒子位置数据作为纹理变量添加到GPGPU计算器中
// 后续在shader中通过gl_FragCoord/resolution获取UV坐标来访问对应粒子
gpgpu.particlesVariable = gpgpu.computation.addVariable('uParticles', gpgpuParticlesShader, baseParticlePositionTexture)
gpgpu.computation.setVariableDependencies(gpgpu.particlesVariable, [gpgpu.particlesVariable])

// Uniforms
// uDisplacementTexture: 2D canvas绘制的鼠标glow纹理，用于抬起粒子
// uDisplacementSpread: xy平面散开系数
// uDisplacementZScale: z轴抬起系数
gpgpu.particlesVariable.material.uniforms.uTime = new THREE.Uniform(0)
gpgpu.particlesVariable.material.uniforms.uDeltaTime = new THREE.Uniform(0)
gpgpu.particlesVariable.material.uniforms.uBase = new THREE.Uniform(baseParticlePositionTexture)
gpgpu.particlesVariable.material.uniforms.uFlowFieldInfluence = new THREE.Uniform(0.5)
gpgpu.particlesVariable.material.uniforms.uFlowFieldStrength = new THREE.Uniform(2.0)
gpgpu.particlesVariable.material.uniforms.uFlowFieldFrequency = new THREE.Uniform(0.5)
gpgpu.particlesVariable.material.uniforms.uDisplacementTexture = new THREE.Uniform(displacement.texture)
gpgpu.particlesVariable.material.uniforms.uDisplacementStrength = new THREE.Uniform(1.5)
gpgpu.particlesVariable.material.uniforms.uDisplacementSpread = new THREE.Uniform(0.3)
gpgpu.particlesVariable.material.uniforms.uDisplacementZScale = new THREE.Uniform(0.8)
gpgpu.particlesVariable.material.uniforms.uCameraPosition = new THREE.Uniform(camera.position)
// 光标互动功能开关：0.0=关闭(默认), 1.0=开启
gpgpu.particlesVariable.material.uniforms.uDisplacementEnabled = new THREE.Uniform(0.0)
// 粒子运动速度倍率：控制光标互动时粒子移动的快慢
gpgpu.particlesVariable.material.uniforms.uDisplacementSpeed = new THREE.Uniform(5.0)

// Init
gpgpu.computation.init()

// Debug
gpgpu.debug = new THREE.Mesh(
    new THREE.PlaneGeometry(3, 3),
    new THREE.MeshBasicMaterial({
        map: gpgpu.computation.getCurrentRenderTarget(gpgpu.particlesVariable).texture
    })
)
gpgpu.debug.visible = false
gpgpu.debug.position.x = 3
scene.add(gpgpu.debug)


/**
 * Particles
 * 
 * 【粒子UV映射生成】
 * 每个粒子需要知道自己的UV坐标，才能在GPGPU纹理中找到自己的位置。
 * aParticlesUv 属性存储每个粒子的UV坐标(0-1范围)。
 * 
 * UV生成逻辑：
 * - 将粒子按gpgpu.size宽度排列成2D网格
 * - x方向: (列索引 + 0.5) / 总宽度 -> 0到1
 * - y方向: (行索引 + 0.5) / 总高度 -> 0到1
 * 
 * 这个UV坐标与以下三者一一对应：
 * 1. GPGPU纹理中的像素位置 (gl_FragCoord.xy / resolution.xy)
 * 2. Displacement纹理的采样位置
 * 3. 交互平面的UV坐标 (raycaster intersect返回的uv)
 */
const particles = {}

// Geometry
// aParticlesUv: 每个粒子的UV坐标，用于在GPGPU纹理中定位自己
const particlesUvArray = new Float32Array(baseGeometry.count * 2)
const sizesArry = new Float32Array(baseGeometry.count)

for(let y = 0; y < gpgpu.size; y++)
{
    for(let x = 0; x < gpgpu.size; x++)
    {
        const i =(y*gpgpu.size + x)
        const i2 = i * 2

        // 计算该粒子在GPGPU纹理中的UV坐标
        // (x + 0.5) / gpgpu.size: 添加0.5偏移，采样像素中心
        const uvX = (x + 0.5) / gpgpu.size
        const uvY = (y + 0.5) / gpgpu.size
        particlesUvArray[i2] = uvX
        particlesUvArray[i2 + 1] = uvY

        // Size
        sizesArry[i] = Math.random()
    }
}

particles.geometry = new THREE.BufferGeometry()
particles.geometry.setDrawRange(0, baseGeometry.count)
// 将UV坐标作为属性传递给vertex shader
// vertex shader用它从uParticlesTexture采样当前位置
particles.geometry.setAttribute('aParticlesUv', new THREE.BufferAttribute(particlesUvArray, 2))
particles.geometry.setAttribute('aColor', baseGeometry.instance.attributes.color)
particles.geometry.setAttribute('aSize', new THREE.BufferAttribute(sizesArry, 1))

// Material
particles.material = new THREE.ShaderMaterial({
    vertexShader: particlesVertexShader,
    fragmentShader: particlesFragmentShader,
    uniforms:
    {
        uSize: new THREE.Uniform(0.07),
        uResolution: new THREE.Uniform(new THREE.Vector2(sizes.width * sizes.pixelRatio, sizes.height * sizes.pixelRatio)),
        uParticlesTexture: new THREE.Uniform(),
        // 距离缩小参数：控制粒子远离模型中心时的大小变化
        uModelCenter: new THREE.Uniform(modelCenter), // 模型边界盒中心
        uShrinkNear: new THREE.Uniform(0.0),    // 开始缩小的距离
        uShrinkFar: new THREE.Uniform(3.0),    // 完全缩小的距离
        uShrinkMin: new THREE.Uniform(0.05)      // 最小缩小比例 (0-1)
    }
})

// Points
particles.points = new THREE.Points(particles.geometry, particles.material)
scene.add(particles.points)

/**
 * Tweaks
 */
gui.addColor(debugObject, 'clearColor').onChange(() => { renderer.setClearColor(debugObject.clearColor) })
gui.add(particles.material.uniforms.uSize, 'value').min(0).max(1).step(0.001).name('uSize')

gui.add(gpgpu.particlesVariable.material.uniforms.uFlowFieldInfluence, 'value').min(0).max(1).step(0.001).name('uFlowFieldInfluence')
gui.add(gpgpu.particlesVariable.material.uniforms.uFlowFieldStrength, 'value').min(0).max(10).step(0.1).name('uFlowFieldStrength')
gui.add(gpgpu.particlesVariable.material.uniforms.uFlowFieldFrequency, 'value').min(0).max(1).step(0.001).name('uFlowFieldFrequency')

// 【光标互动功能开关】
// 默认关闭(0.0)，开启后鼠标悬停可抬起粒子
debugObject.cursorInteraction = false
gui.add(debugObject, 'cursorInteraction').name('Cursor Interaction').onChange((value) => {
    gpgpu.particlesVariable.material.uniforms.uDisplacementEnabled.value = value ? 1.0 : 0.0
})

// Displacement参数（仅在开启时有效）
const displacementFolder = gui.addFolder('Displacement Settings')
// glowSize系数：控制光标作用范围大小，0.0-1.0范围
debugObject.glowSizeMultiplier = 0.25
displacementFolder.add(debugObject, 'glowSizeMultiplier').min(0).max(1).step(0.01).name('Glow Size')
displacementFolder.add(gpgpu.particlesVariable.material.uniforms.uDisplacementStrength, 'value').min(0).max(5).step(0.1).name('Strength')
displacementFolder.add(gpgpu.particlesVariable.material.uniforms.uDisplacementSpread, 'value').min(0).max(1).step(0.01).name('Spread')
displacementFolder.add(gpgpu.particlesVariable.material.uniforms.uDisplacementZScale, 'value').min(0).max(2).step(0.01).name('Z Scale')
// 粒子运动速度倍率：控制光标互动时粒子移动的快慢
displacementFolder.add(gpgpu.particlesVariable.material.uniforms.uDisplacementSpeed, 'value').min(0).max(20).step(0.1).name('Speed')

// 粒子大小参数
const sizeFolder = gui.addFolder('Particle Size')
sizeFolder.add(particles.material.uniforms.uShrinkNear, 'value').min(0).max(20).step(0.5).name('Shrink Near')
sizeFolder.add(particles.material.uniforms.uShrinkFar, 'value').min(0).max(30).step(0.5).name('Shrink Far')
sizeFolder.add(particles.material.uniforms.uShrinkMin, 'value').min(0).max(1).step(0.05).name('Shrink Min')

/**
 * Animate
 */
const clock = new THREE.Clock()
let previousTime = 0

const tick = () =>
{
    const elapsedTime = clock.getElapsedTime()
    const deltaTime = elapsedTime - previousTime
    previousTime = elapsedTime
    
    // Update controls
    controls.update()

    /**
     * Raycaster - 检测鼠标位置
     * 
     * 【UV映射流程】
     * 1. Raycaster从相机发射射线，检测与交互平面的交点
     * 2. 交点的uv属性是平面上的归一化坐标(0-1范围)
     * 3. 这个uv坐标直接对应：
     *    - Canvas上的绘制位置
     *    - Displacement texture的采样位置
     *    - GPGPU纹理中对应粒子的位置
     * 
     * 三者UV空间一致，实现鼠标位置到粒子抬起的映射。
     */
    displacement.raycaster.setFromCamera(displacement.screenCursor, camera)
    const intersects = displacement.raycaster.intersectObject(displacement.interactivePlane)
    
    if (intersects.length) {
        // intersects[0].uv: 平面上的UV坐标 (0-1)
        // 直接对应displacement texture和GPGPU texture的UV坐标
        const uv = intersects[0].uv
        // 将UV(0-1)映射到canvas像素坐标
        displacement.canvasCursor.x = uv.x * displacement.canvas.width
        displacement.canvasCursor.y = (1 - uv.y) * displacement.canvas.height
    }

    /**
     * Displacement - 绘制glow效果到canvas
     */
    // Fade out
    displacement.context.globalCompositeOperation = 'source-over'
    displacement.context.globalAlpha = 0.02
    displacement.context.fillRect(0, 0, displacement.canvas.width, displacement.canvas.height)

    // Speed alpha
    const cursorDistance = displacement.canvasCursorPrevious.distanceTo(displacement.canvasCursor)
    displacement.canvasCursorPrevious.copy(displacement.canvasCursor)
    const alpha = Math.min(cursorDistance * 0.1, 1)

    // Draw glow
    const glowSize = displacement.canvas.width * debugObject.glowSizeMultiplier
    displacement.context.globalCompositeOperation = 'lighten'
    displacement.context.globalAlpha = alpha
    displacement.context.drawImage(
        displacement.glowImage,
        displacement.canvasCursor.x - glowSize / 2,
        displacement.canvasCursor.y - glowSize / 2,
        glowSize,
        glowSize
    )
    
    // Update texture
    displacement.texture.needsUpdate = true

    /**
     * Update interactive plane - 位于模型后方，面向相机
     */
    const cameraDirection = new THREE.Vector3().subVectors(modelCenter, camera.position).normalize()
    displacement.interactivePlane.position.copy(modelCenter).add(cameraDirection.multiplyScalar(-3)) // 模型后方3个单位
    displacement.interactivePlane.lookAt(camera.position)
    gpgpu.particlesVariable.material.uniforms.uTime.value = elapsedTime
    gpgpu.particlesVariable.material.uniforms.uDeltaTime.value = deltaTime
    gpgpu.particlesVariable.material.uniforms.uCameraPosition.value.copy(camera.position)
    gpgpu.computation.compute()
    particles.material.uniforms.uParticlesTexture.value = gpgpu.computation.getCurrentRenderTarget(gpgpu.particlesVariable).texture

    // Render normal scene
    renderer.render(scene, camera)

    // Call tick again on the next frame
    window.requestAnimationFrame(tick)
}

tick()