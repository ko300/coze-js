/**
 * 流式音频重采样器
 * 支持跨分片状态保持，彻底消除分片拼接处的波形断层
 */
export class StreamResampler {
  private inputSampleRate: number;
  private outputSampleRate: number;
  private lastFraction = 0.0; // 记录上一包末尾遗留的小数位偏移

  constructor(inputSampleRate: number, outputSampleRate: number) {
    this.inputSampleRate = inputSampleRate;
    this.outputSampleRate = outputSampleRate;
  }

  /**
   * 对一段 PCM 分片进行重采样，自动补偿上一包的小数位偏移
   * @param {Int16Array} inputBuffer - 输入 PCM 分片
   * @returns {Int16Array} - 重采样后的 PCM 分片
   */
  resample(inputBuffer: Int16Array): Int16Array {
    if (this.inputSampleRate === this.outputSampleRate) {
      return inputBuffer;
    }

    const ratio = this.outputSampleRate / this.inputSampleRate;
    // 补偿上一包末尾遗留的小数偏移，精确计算本包最大可能输出长度
    const maxOutputLength = Math.ceil(
      (inputBuffer.length - this.lastFraction) * ratio,
    );
    const outputBuffer = new Int16Array(maxOutputLength);

    let actualOutputLength = 0;

    for (let i = 0; i < maxOutputLength; i++) {
      // 从上一包遗留的小数偏移处开始计算当前输出点对应的输入位置
      const inputPos = this.lastFraction + i / ratio;
      const inputIndex = Math.floor(inputPos);

      // 越界：当前包数据不足以完成下一次双点插值
      // 正确做法是截断，并将此刻的 inputPos 小数部分保存为下一包的起始偏移
      // 不能强行填充，否则会造成指针超额消费，引发累积漂移
      if (inputIndex >= inputBuffer.length - 1) {
        // 精确计算跨包起始小数位：inputPos 相对于本包末尾的超出量
        // 即下一包从 inputPos - (inputBuffer.length - 1) 处开始读取
        this.lastFraction = inputPos - (inputBuffer.length - 1);
        break;
      }

      const fraction = inputPos - inputIndex;
      const sample1 = inputBuffer[inputIndex];
      const sample2 = inputBuffer[inputIndex + 1];
      const interpolatedValue = sample1 + fraction * (sample2 - sample1);
      outputBuffer[actualOutputLength] = Math.max(
        Math.min(Math.round(interpolatedValue), 32767),
        -32768,
      );
      actualOutputLength++;
    }

    // 若循环正常跑完（未因越界 break），按实际消费量更新 lastFraction
    if (actualOutputLength === maxOutputLength) {
      const totalInputConsumed = this.lastFraction + maxOutputLength / ratio;
      this.lastFraction = totalInputConsumed - Math.floor(totalInputConsumed);
    }

    // 裁剪掉因越界提前截断而未填充的尾部空槽
    return actualOutputLength === maxOutputLength
      ? outputBuffer
      : outputBuffer.slice(0, actualOutputLength);
  }

  /**
   * 重置小数位偏移（切换音轨/中断时调用，防止残留状态污染下一段音频）
   */
  reset(): void {
    this.lastFraction = 0.0;
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
