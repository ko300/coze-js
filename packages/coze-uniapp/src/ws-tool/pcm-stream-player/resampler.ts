/**
 * 流式音频重采样器
 * 跨分片保持两项状态：小数位偏移 + 上一包末尾样本，
 * 保证分片边界区间也有正常插值，消除拼接处的波形断层
 */
export class StreamResampler {
  private inputSampleRate: number;
  private outputSampleRate: number;
  private lastFraction = 0.0; // 下一个输出点相对"虚拟缓冲"起点的位置
  private hasLastSample = false; // 是否持有上一包末尾样本
  private lastSample = 0; // 上一包最后一个输入样本，用于跨包插值

  constructor(inputSampleRate: number, outputSampleRate: number) {
    this.inputSampleRate = inputSampleRate;
    this.outputSampleRate = outputSampleRate;
  }

  /**
   * 对一段 PCM 分片进行重采样
   * 虚拟缓冲 = [上一包末尾样本] + 本包，使跨包区间 [prev末样本, next首样本] 也被插值覆盖
   * @param {Int16Array} inputBuffer - 输入 PCM 分片
   * @returns {Int16Array} - 重采样后的 PCM 分片
   */
  resample(inputBuffer: Int16Array): Int16Array {
    if (
      this.inputSampleRate === this.outputSampleRate ||
      inputBuffer.length === 0
    ) {
      return inputBuffer;
    }

    const step = this.inputSampleRate / this.outputSampleRate;
    const prependCount = this.hasLastSample ? 1 : 0;
    const virtualLength = inputBuffer.length + prependCount;
    // 读取虚拟缓冲第 i 个样本（0 号位可能是上一包末尾样本）
    const readVirtual = (i: number): number =>
      i < prependCount ? this.lastSample : inputBuffer[i - prependCount];

    const maxOutputLength = Math.max(
      Math.ceil((virtualLength - 1 - this.lastFraction) / step) + 1,
      0,
    );
    const outputBuffer = new Int16Array(maxOutputLength);

    let outputCount = 0;
    let pos = this.lastFraction;
    while (Math.floor(pos) < virtualLength - 1) {
      const index = Math.floor(pos);
      const fraction = pos - index;
      const sample1 = readVirtual(index);
      const sample2 = readVirtual(index + 1);
      const value = sample1 + fraction * (sample2 - sample1);
      outputBuffer[outputCount] = Math.max(
        Math.min(Math.round(value), 32767),
        -32768,
      );
      outputCount++;
      pos += step;
    }

    // 保存本包末尾样本供下一包插值；pos 已越过虚拟缓冲最后一个可插值区间
    this.lastSample = readVirtual(virtualLength - 1);
    this.hasLastSample = true;
    this.lastFraction = pos - (virtualLength - 1);

    return outputCount === outputBuffer.length
      ? outputBuffer
      : outputBuffer.slice(0, outputCount);
  }

  /**
   * 重置跨包状态（切换音轨/中断时调用，防止残留状态污染下一段音频）
   */
  reset(): void {
    this.lastFraction = 0.0;
    this.hasLastSample = false;
    this.lastSample = 0;
  }
}

/**
 * 兼容旧版静态调用的 Resampler（保留，避免其他地方有引用）
 */
export const Resampler = {
  resample(
    inputBuffer: Int16Array,
    inputSampleRate: number,
    outputSampleRate: number,
  ): Int16Array {
    if (inputSampleRate === outputSampleRate) {
      return inputBuffer;
    }
    const ratio = outputSampleRate / inputSampleRate;
    const outputLength = Math.ceil(inputBuffer.length * ratio);
    const outputBuffer = new Int16Array(outputLength);
    for (let i = 0; i < outputLength; i++) {
      const inputPos = i / ratio;
      const inputIndex = Math.floor(inputPos);
      const fraction = inputPos - inputIndex;
      if (inputIndex >= inputBuffer.length - 1) {
        outputBuffer[i] = inputBuffer[inputBuffer.length - 1];
        continue;
      }
      const sample1 = inputBuffer[inputIndex];
      const sample2 = inputBuffer[inputIndex + 1];
      const interpolatedValue = sample1 + fraction * (sample2 - sample1);
      outputBuffer[i] = Math.max(
        Math.min(Math.round(interpolatedValue), 32767),
        -32768,
      );
    }
    return outputBuffer;
  },
};
