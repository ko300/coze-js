/* eslint-disable @typescript-eslint/no-explicit-any */
import { StreamResampler } from './resampler';
import { decodeAlaw, decodeUlaw } from './codecs/g711';

// 缓冲水位（毫秒）：初始启动与断流恢复都要积攒到该水位才开始/恢复输出
const JITTER_BUFFER_MS = 200;
// 尾包排空超时（毫秒）：处于积攒状态但超过该时长没有新包到达，视为流已结束，直接排空剩余数据
const DRAIN_TIMEOUT_MS = 250;
// 恢复输出时的淡入步长（每样本增量，48kHz 下约 5ms 完成淡入，防爆音）
const FADE_IN_STEP = 1 / 256;

/**
 * PcmStreamPlayer 支持的音频格式
 */
export type AudioFormat = 'pcm' | 'g711a' | 'g711u';

/**
 * 微信小程序流式 PCM 播放器
 * 支持 PCM16、G.711a、G.711u 格式的音频流实时播放
 * @class
 */
export class PcmStreamPlayer {
  private audioContext: any | null = null; // 使用 any 类型，避免 WebAudioContext 类型限制
  private inputSampleRate: number;
  private outputSampleRate: number;
  private audioQueue: Int16Array[] = []; // 已解码的 PCM 数据队列，等待播放
  private volume = 1.0; // 音量，范围 0.0（静音）~ 1.0（最大）
  private trackSampleOffsets: Record<
    string,
    { trackId: string; offset: number; currentTime: number }
  > = {};
  private interruptedTrackIds: Record<string, boolean> = {}; // 已被中断的 trackId
  private isInitialized = false; // 音频上下文是否已初始化
  private isProcessing = false; // scriptNode 是否正在播放（有数据输出）
  private scriptNode: any = null; // ScriptProcessorNode 实例
  // 【优化】bufferSize 从 1024 调大为 4096：
  // 1024 samples 在 44100Hz 下仅约 23ms 窗口，主线程稍忙就会输出静音帧产生爆音/噪音。
  // 4096 samples 约 93ms，容错余量充足，可有效减少噪音和卡顿。
  private bufferSize = 4096;
  private base64Queue: Array<{ base64String: string; trackId: string }> = []; // 待解码的 base64 队列
  private isProcessingQueue = false; // 是否正在处理 base64 队列
  private base64ProcessScheduled = false; // 是否已调度了 base64 处理任务
  private lastAudioProcessTime = 0; // 上次 onaudioprocess 触发的时间戳
  private processingTimeThreshold = 0; // 距下一帧的安全时间窗口（ms）
  private isPaused = false; // 是否处于暂停状态

  // 流式重采样器实例（支持跨分片状态保持）
  private resampler: StreamResampler | null = null;
  // 淡出时保存上一个采样点，用于断流时平滑过渡到静音
  private fadeLastSample = 0.0;

  // 当前正在播放的 PCM buffer 及其读取位置
  private currentBuffer: Int16Array | null = null;
  private playbackPosition = 0;

  // 缓冲状态机：初始/断流后为 true，此时只输出静音，水位达标或尾包超时才恢复输出
  private isBuffering = true;
  // 恢复输出时的淡入增益（0~1）
  private resumeGain = 1.0;
  // 最后一个数据包到达时间，用于尾包排空判断
  private lastChunkTime = 0;

  /** 默认音频格式 */
  private defaultFormat: AudioFormat = 'pcm';

  // 用于绕过 iPhone 静音开关的静音音频实例（静态，全局只需一个）
  private static triggerAudio: any = null;
  // 缓存系统采样率，避免重复创建/销毁 WebAudioContext
  private static cachedSampleRate: number | null = null;

  /**
   * 创建 PcmStreamPlayer 实例
   * @param {{sampleRate?: number, defaultFormat?: AudioFormat, volume?: number}} options
   */
  constructor({
    sampleRate = 24000,
    defaultFormat = 'pcm',
    volume = 1.0,
  }: {
    sampleRate?: number;
    defaultFormat?: AudioFormat;
    volume?: number;
  } = {}) {
    this.inputSampleRate = sampleRate;
    // 微信小程序输出采样率固定，需要重采样
    this.outputSampleRate = PcmStreamPlayer.getSampleRate();
    this.defaultFormat = defaultFormat;
    this.setVolume(volume);
    // 初始化流式重采样器
    this.resampler = new StreamResampler(
      this.inputSampleRate,
      this.outputSampleRate,
    );
  }
  /**
   * 初始化 WebAudioContext
   * @private
   */
  private initialize(): boolean {
    if (this.isInitialized) {
      return true;
    }

    try {
      this.audioContext = uni.createWebAudioContext();

      if (!this.audioContext) {
        console.error('创建 WebAudioContext 失败');
        return false;
      }

      // 计算安全解码窗口：一帧时长减去 5ms 的余量
      this.processingTimeThreshold =
        Math.floor((this.bufferSize / this.audioContext.sampleRate) * 1000) - 5;

      // 初始化 iPhone 静音模式绕过
      this.initSilentModeTrigger();

      this.isInitialized = true;
      return true;
    } catch (error) {
      console.error('初始化音频上下文出错:', error);
      return false;
    }
  }

  /**
   * 初始化静音音频，用于绕过 iPhone 静音开关
   * @private
   */
  private initSilentModeTrigger(): void {
    try {
      // 全局只需初始化一次
      if (!PcmStreamPlayer.triggerAudio) {
        uni.setInnerAudioOption({
          obeyMuteSwitch: false, // 忽略静音开关
          success: () => {
            console.log('已设置 obeyMuteSwitch=false');
          },
          fail: err => {
            console.error('设置 obeyMuteSwitch 失败:', err);
          },
        });

        const triggerAudio = uni.createInnerAudioContext();
        // 使用极短的静音 mp3，循环播放以保持音频会话活跃
        triggerAudio.src =
          'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQwAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAACAAABIADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV6urq6urq6urq6urq6urq6urq6urq6urq6v////////////////////////////////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAAAAAAAAAAAASAthz7PAAAAAAAAAAAAAAAA//tAwAAABpADjMQAACK2IHbYwggI0JMZ4M8y5wPEI7iSHf5DMjMH5QdHI25QZIguRmDIJnoZgyDGfCUGQdBjGDa+jm7aGaABBAEAghzNIJhJRmCEYbJkHmUCuMY1/AAIAAQACAQ8QDSSQTJ7gICAwQkDSiYVBpgoBnJDQA==';
        triggerAudio.loop = true;
        triggerAudio.volume = 0.01; // 极小音量，仅用于激活音频会话
        triggerAudio.obeyMuteSwitch = false;

        PcmStreamPlayer.triggerAudio = triggerAudio;

        triggerAudio.onPlay = () => {
          console.log('静音触发音频已播放');
        };
        triggerAudio.play();
      }
    } catch (error) {
      console.error('初始化静音触发器出错:', error);
    }
  }

  /**
   * 启动 ScriptProcessorNode 开始音频输出
   * @private
   */
  private startPlayback(): boolean {
    try {
      if (!this.isInitialized) {
        const initialized = this.initialize();
        if (!initialized) {
          return false;
        }
      }

      // 队列为空时不启动
      if (this.audioQueue.length === 0) {
        return false;
      }

      // scriptNode 常驻复用：已存在时不再拆建，拆建节点会在播放中产生爆音
      if (this.scriptNode) {
        return true;
      }

      const scriptNode = this.audioContext?.createScriptProcessor
        ? this.audioContext.createScriptProcessor(this.bufferSize, 0, 1)
        : null;

      if (!scriptNode) {
        console.error('创建 ScriptProcessorNode 失败');
        return false;
      }

      this.scriptNode = scriptNode;
      this.isProcessing = true;

      scriptNode.onaudioprocess = (e: any) => {
        const outputBuffer = e.outputBuffer.getChannelData(0);

        // 填充输出帧
        this.fillOutputBuffer(outputBuffer);

        // 记录本次帧处理时间，用于 isProcessingIdle 判断
        this.lastAudioProcessTime = Date.now();

        // 在音频回调外调度 base64 解码，避免阻塞音频线程
        this.scheduleBase64QueueProcess();
      };

      scriptNode.connect(this.audioContext?.destination);
      return true;
    } catch (error) {
      console.error('启动音频播放出错:', error);
      return false;
    }
  }

  /**
   * 计算当前已缓冲的音频时长（毫秒），含正在播放的 buffer 剩余部分
   * @private
   */
  private getBufferedMs(): number {
    let samples = this.audioQueue.reduce((sum, chunk) => sum + chunk.length, 0);
    if (this.currentBuffer) {
      samples += Math.max(0, this.currentBuffer.length - this.playbackPosition);
    }
    return (samples / this.outputSampleRate) * 1000;
  }

  /**
   * 将 audioQueue 中的数据填充到输出帧
   *
   * 缓冲状态机（是否出声的唯一控制点）：
   * - isBuffering=true：只输出淡出尾音/静音，不消费队列；
   *   攒够 JITTER_BUFFER_MS 恢复输出；或队列有数据但超过 DRAIN_TIMEOUT_MS
   *   没有新包（流已结束），直接排空剩余数据
   * - 播放中队列耗尽：本帧余下淡出，重新进入 isBuffering
   * 恢复输出时用 resumeGain 做短淡入，防止波形突跳爆音
   * @private
   */
  private fillOutputBuffer(outputBuffer: Float32Array): void {
    const vol = this.volume <= 0 ? 0 : this.volume;

    if (this.isBuffering) {
      const bufferedMs = this.getBufferedMs();
      const streamEnded =
        bufferedMs > 0 &&
        this.lastChunkTime > 0 &&
        Date.now() - this.lastChunkTime > DRAIN_TIMEOUT_MS;
      if (bufferedMs >= JITTER_BUFFER_MS || streamEnded) {
        this.isBuffering = false;
        this.resumeGain = 0.0;
      } else {
        // 水位不足：输出淡出尾音/静音等待积攒
        for (let j = 0; j < outputBuffer.length; j++) {
          this.fadeLastSample *= 0.98;
          outputBuffer[j] = this.fadeLastSample;
        }
        this.isProcessing = false;
        return;
      }
    }

    let hasData = true;
    for (let i = 0; i < outputBuffer.length; i++) {
      // 当前 buffer 耗尽时，尝试从队列获取下一个
      while (
        hasData &&
        (!this.currentBuffer ||
          this.playbackPosition >= this.currentBuffer.length)
      ) {
        hasData = this.getNextBuffer();
      }

      if (hasData && this.currentBuffer) {
        if (this.resumeGain < 1.0) {
          this.resumeGain = Math.min(1.0, this.resumeGain + FADE_IN_STEP);
        }
        let sample =
          (this.currentBuffer[this.playbackPosition] / 0x8000) *
          vol *
          this.resumeGain;
        // 硬限幅，防止数值溢出导致爆音
        if (sample > 1.0) {
          sample = 1.0;
        } else if (sample < -1.0) {
          sample = -1.0;
        }
        outputBuffer[i] = sample;
        this.fadeLastSample = sample; // 记录最后一个有效样本，供断流淡出衔接
        this.playbackPosition++;
      } else {
        // 队列耗尽：本帧余下淡出，进入重新积攒状态
        for (let j = i; j < outputBuffer.length; j++) {
          this.fadeLastSample *= 0.98;
          outputBuffer[j] = this.fadeLastSample;
        }
        // 仅在"包还在到达却断流"时告警（真饿死）；正常回复播完的收尾静默进入积攒
        if (
          this.lastChunkTime > 0 &&
          Date.now() - this.lastChunkTime <= DRAIN_TIMEOUT_MS
        ) {
          console.log('[PcmStreamPlayer] 缓冲耗尽，进入重新积攒');
        }
        this.isBuffering = true;
        this.isProcessing = false;
        return;
      }
    }

    // 注意：整帧填满后不再把 fadeLastSample 清零，
    // 下一帧若一开始就断流，要从真实的最后样本淡出，否则帧边界断流会爆音
    this.isProcessing = true;
  }

  /**
   * 从 audioQueue 取出下一段 PCM 数据，准备播放
   * @private
   */
  private getNextBuffer(): boolean {
    if (this.audioQueue.length === 0) {
      return false;
    }

    const pcmData = this.audioQueue.shift();
    if (!pcmData || pcmData.length === 0) {
      this.currentBuffer = null;
      return false;
    }

    // 保持 Int16Array 格式，播放时再按需转换为 Float32
    this.currentBuffer = pcmData;
    this.playbackPosition = 0;
    return true;
  }

  /**
   * 暂停音频播放
   */
  async pause(): Promise<void> {
    if (this.audioContext && !this.isPaused) {
      try {
        if (
          this.audioContext?.state === 'running' &&
          typeof this.audioContext?.suspend === 'function'
        ) {
          await this.audioContext.suspend();
        }
        this.isPaused = true;
      } catch (error) {
        console.error('暂停音频出错:', error);
      }
    }
  }

  /**
   * 恢复音频播放
   */
  async resume(): Promise<void> {
    if (this.audioContext && this.isPaused) {
      try {
        if (
          this.audioContext?.state === 'suspended' &&
          typeof this.audioContext?.resume === 'function'
        ) {
          await this.audioContext.resume();
        }
        this.isPaused = false;

        // 如果 scriptNode 已断开，重新启动播放
        if (!this.scriptNode && this.audioQueue.length > 0) {
          await this.startPlayback();
        }
      } catch (error) {
        console.error('恢复音频出错:', error);
      }
    }
  }

  /**
   * 切换播放/暂停状态
   */
  async togglePlay(): Promise<void> {
    if (this.isPaused) {
      await this.resume();
    } else {
      await this.pause();
    }
  }

  /**
   * 判断是否正在播放
   */
  isPlaying(): boolean {
    return Boolean(
      this.audioContext &&
        !this.isPaused &&
        (this.isProcessing || this.audioQueue.length > 0) &&
        this.audioContext?.state === 'running',
    );
  }

  /**
   * 判断当前主线程是否处于适合解码的空闲窗口
   *
   * 说明：
   * - diff 表示距“上一帧 onaudioprocess 回调”的时间差
   * - 理想的解码时机是“刚处理完一帧之后到下一帧到来之前”的这段时间
   * - 因此应在 diff < threshold 时判定为可解码
   *
   * 判定规则：
   * - diff > 100ms：音频回调可能已停止，允许解码
   * - diff < threshold：处于当前帧后的安全窗口，允许解码
   * - 其他：太靠近下一帧，跳过本次解码避免阻塞音频回调
   * @private
   */
  private isProcessingIdle(): boolean {
    if (this.lastAudioProcessTime === 0) {
      // 音频尚未开始，直接允许解码
      return true;
    }

    const now = Date.now();
    const diff = now - this.lastAudioProcessTime;

    if (diff > 100) {
      return true;
    }

    if (diff < this.processingTimeThreshold) {
      return true;
    }

    return false;
  }

  /**
   * 将 base64 编码的 PCM 数据加入待解码队列
   * 通过队列异步解码，避免阻塞主线程
   * @param {string} base64String - base64 编码的 PCM 数据
   * @param {string} trackId - 音轨标识
   */
  addBase64PCM(base64String: string, trackId = 'default') {
    this.base64Queue.push({ base64String, trackId });
    this.scheduleBase64QueueProcess();
    return true;
  }

  /**
   * 调度 base64 解码任务（通过 setTimeout 放到宏任务，避免在音频回调中同步执行）
   * @private
   */
  private scheduleBase64QueueProcess() {
    if (this.base64ProcessScheduled || this.base64Queue.length === 0) {
      return;
    }

    this.base64ProcessScheduled = true;

    setTimeout(() => {
      this.base64ProcessScheduled = false;
      if (this.isProcessingIdle()) {
        this.processBase64Queue();
      }
    }, 0);
  }

  /**
   * 处理 base64 解码队列
   *
   * 【修复】原代码每次只处理一条，再通过 scheduleBase64QueueProcess 调度下一条（新的 setTimeout）。
   * 当来包频繁时，解码速度远跟不上入队速度，audioQueue 持续饿死，产生卡顿。
   *
   * 修复方案：每次最多处理 MAX_PER_TURN 条，加快队列消耗速度，
   * 同时避免单次处理过多阻塞主线程。
   * @private
   */
  private processBase64Queue() {
    if (this.isProcessingQueue || this.base64Queue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    try {
      // 每次最多处理 4 条，平衡解码速度与主线程占用
      const MAX_PER_TURN = 4;
      let processed = 0;
      while (this.base64Queue.length > 0 && processed < MAX_PER_TURN) {
        const item = this.base64Queue.shift();
        if (item) {
          const { base64String, trackId } = item;
          const binaryString = uni.base64ToArrayBuffer(base64String);
          this.add16BitPCM(binaryString, trackId);
          processed++;
        }
      }
    } catch (error) {
      console.error('处理 base64 队列出错:', error);
    } finally {
      this.isProcessingQueue = false;

      // 队列还有数据，继续调度
      if (this.base64Queue.length > 0) {
        this.scheduleBase64QueueProcess();
      }
    }
  }

  /**
   * 将解码后的 PCM 数据加入播放队列
   * @param {ArrayBuffer|Int16Array|Uint8Array} arrayBuffer
   * @param {string} [trackId]
   * @param {AudioFormat} [format] - 音频格式：'pcm'、'g711a' 或 'g711u'
   */
  add16BitPCM(
    arrayBuffer: ArrayBuffer | Int16Array | Uint8Array,
    trackId = 'default',
    format?: AudioFormat,
  ): Int16Array {
    if (typeof trackId !== 'string') {
      throw new Error('trackId 必须是字符串');
    } else if (this.interruptedTrackIds[trackId]) {
      // 该 track 已被中断，丢弃数据
      return new Int16Array();
    }

    let buffer: Int16Array;
    const audioFormat = format || this.defaultFormat;

    if (arrayBuffer instanceof Int16Array) {
      // 已经是 PCM 格式，直接使用
      buffer = arrayBuffer;
    } else if (arrayBuffer instanceof Uint8Array) {
      if (audioFormat === 'g711a') {
        buffer = decodeAlaw(arrayBuffer);
      } else if (audioFormat === 'g711u') {
        buffer = decodeUlaw(arrayBuffer);
      } else {
        // PCM 格式，注意对齐字节数
        const byteLength =
          arrayBuffer.byteLength - (arrayBuffer.byteLength % 2);
        buffer = new Int16Array(
          arrayBuffer.buffer,
          arrayBuffer.byteOffset,
          Math.floor(byteLength / 2),
        );
      }
    } else if (arrayBuffer instanceof ArrayBuffer) {
      if (audioFormat === 'g711a') {
        buffer = decodeAlaw(new Uint8Array(arrayBuffer));
      } else if (audioFormat === 'g711u') {
        buffer = decodeUlaw(new Uint8Array(arrayBuffer));
      } else {
        buffer = new Int16Array(arrayBuffer);
      }
    } else {
      throw new Error('参数必须是 Int16Array、Uint8Array 或 ArrayBuffer');
    }

    // 输入与输出采样率不同时，进行重采样
    if (this.inputSampleRate !== this.outputSampleRate && this.resampler) {
      buffer = this.resampler.resample(buffer);
    }

    this.audioQueue.push(buffer);
    this.lastChunkTime = Date.now();

    // scriptNode 首包即创建并常驻；是否出声统一由 fillOutputBuffer 的
    // 缓冲状态机（水位 + 尾包超时）控制，此处不再做启动判断，消除双路竞态
    if (!this.scriptNode && !this.isPaused) {
      this.startPlayback();
    }

    return buffer;
  }

  /**
   * 获取当前播放流的采样偏移量
   * @param {boolean} [interrupt] - 是否同时中断当前播放
   */
  getTrackSampleOffset(interrupt = false): {
    trackId: string | null;
    offset: number;
    currentTime: number;
  } | null {
    if (!this.audioContext) {
      return null;
    }

    const currentTime = this.audioContext?.currentTime || 0;
    const offset = Math.floor(currentTime * this.inputSampleRate);
    const requestId = Date.now().toString();
    const trackId = 'default';

    const result = {
      trackId,
      offset,
      currentTime,
    };

    this.trackSampleOffsets[requestId] = result;

    if (interrupt && trackId) {
      this.interruptedTrackIds[trackId] = true;

      // 清空已解码和未解码的队列
      this.audioQueue = [];
      this.base64Queue = [];
      this.isProcessingQueue = false;
      this.base64ProcessScheduled = false;

      // 断开当前 scriptNode
      if (this.scriptNode) {
        try {
          this.scriptNode.disconnect();
          this.scriptNode = null;
          this.currentBuffer = null;
          this.playbackPosition = 0;
          this.isPaused = false;
        } catch (error) {
          console.warn('断开 scriptNode 出错:', error);
        }
      }

      // 重置重采样器，防止上一音轨残留的小数位偏移污染下一段音频
      if (this.resampler) {
        this.resampler.reset();
      }
      // 重置淡出状态
      this.fadeLastSample = 0.0;

      // 重置缓冲状态机，下一段音频重新积攒后再出声
      this.isBuffering = true;
      this.resumeGain = 1.0;
      this.lastChunkTime = 0;

      this.isProcessing = false;
    }

    return result;
  }

  /**
   * 中断当前播放，清空所有队列，返回已播放的采样偏移量
   */
  interrupt(): {
    trackId: string | null;
    offset: number;
    currentTime: number;
  } | null {
    this.currentBuffer = null;
    this.playbackPosition = 0;
    return this.getTrackSampleOffset(true);
  }

  /**
   * 设置输入音频的采样率
   * @param {number} sampleRate
   */
  setSampleRate(sampleRate: number): void {
    this.inputSampleRate = sampleRate;
    console.log(
      `输入采样率已设为 ${sampleRate}Hz，输出采样率为 ${this.outputSampleRate}Hz`,
    );
  }

  /**
   * 设置默认音频格式
   * @param {AudioFormat} format
   */
  setDefaultFormat(format: AudioFormat): void {
    this.defaultFormat = format;
  }

  /**
   * 添加 G.711 A-law 编码的音频数据
   * @param {ArrayBuffer|Uint8Array} arrayBuffer
   * @param {string} [trackId]
   */
  addG711a(
    arrayBuffer: ArrayBuffer | Uint8Array,
    trackId = 'default',
  ): Int16Array {
    return this.add16BitPCM(arrayBuffer, trackId, 'g711a');
  }

  /**
   * 添加 G.711 μ-law 编码的音频数据
   * @param {ArrayBuffer|Uint8Array} arrayBuffer
   * @param {string} [trackId]
   */
  addG711u(
    arrayBuffer: ArrayBuffer | Uint8Array,
    trackId = 'default',
  ): Int16Array {
    return this.add16BitPCM(arrayBuffer, trackId, 'g711u');
  }

  /**
   * 获取系统 WebAudioContext 的采样率（带缓存）
   * 仅首次调用时创建上下文，后续直接复用缓存值，降低开销。
   * @returns {number}
   * @static
   */
  static getSampleRate(): number {
    if (PcmStreamPlayer.cachedSampleRate) {
      return PcmStreamPlayer.cachedSampleRate;
    }

    const audioContext = uni.createWebAudioContext() as any;
    const { sampleRate } = audioContext;
    audioContext.close();

    PcmStreamPlayer.cachedSampleRate = sampleRate;
    return sampleRate;
  }

  /**
   * 设置音量
   * @param {number} volume - 0.0（静音）~ 1.0（最大）
   */
  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    console.log(`音量已设为 ${this.volume}`);
  }

  /**
   * 获取当前音量
   */
  getVolume(): number {
    return this.volume;
  }

  /**
   * 清理静态资源（页面卸载或 App 关闭时调用）
   */
  static cleanup(): void {
    if (PcmStreamPlayer.triggerAudio) {
      PcmStreamPlayer.triggerAudio.stop();
      PcmStreamPlayer.triggerAudio.destroy();
      PcmStreamPlayer.triggerAudio = null;
    }
  }
}

// 支持具名导入：import { PcmStreamPlayer } from '@coze/uniapp-api/ws-tools'
export default PcmStreamPlayer;
