// Records an audio input device (default "BlackHole 2ch") and writes raw PCM to stdout:
// 48 kHz, 2 channels, signed 16-bit little-endian, interleaved. server/audio.js pipes it into
// ffmpeg for encoding.
//
// Why not ffmpeg's own avfoundation input: it keeps only the latest audio buffer, so any it doesn't
// read in time is overwritten. On this Mac that lost about 10% of the audio as tiny gaps, heard as
// pops. An AudioQueue with several buffers in hand doesn't drop any.
//
// Build: scripts/build-capture.sh    Run: capture/audio-capture ["Device Name"] > out.raw
import AudioToolbox
import CoreAudio
import Foundation

let deviceName = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "BlackHole 2ch"
let sampleRate = 48000.0
let channels: UInt32 = 2
let bytesPerFrame: UInt32 = 2 * channels
let bufferCount = 8
let framesPerBuffer: UInt32 = 2400 // 50 ms each, so 400 ms in hand before anything could drop

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(1)
}

func stringProperty(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
  var address = AudioObjectPropertyAddress(
    mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var value: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr, let v = value else { return nil }
  return v.takeRetainedValue() as String
}

// The UID of the device with this name (AudioQueue selects devices by UID).
func deviceUID(named name: String) -> String? {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  let system = AudioObjectID(kAudioObjectSystemObject)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr else { return nil }
  var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
  guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &ids) == noErr else { return nil }
  for id in ids where stringProperty(id, kAudioObjectPropertyName) == name {
    return stringProperty(id, kAudioDevicePropertyDeviceUID)
  }
  return nil
}

guard let uid = deviceUID(named: deviceName) else {
  fail("Audio device not found: \(deviceName) (is BlackHole installed and loaded?)")
}

// A closed pipe (ffmpeg gone) should end this process.
signal(SIGPIPE, SIG_DFL)

var format = AudioStreamBasicDescription(
  mSampleRate: sampleRate, mFormatID: kAudioFormatLinearPCM,
  mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
  mBytesPerPacket: bytesPerFrame, mFramesPerPacket: 1, mBytesPerFrame: bytesPerFrame,
  mChannelsPerFrame: channels, mBitsPerChannel: 16, mReserved: 0)

var queue: AudioQueueRef?
var status = AudioQueueNewInput(&format, { _, queue, buffer, _, _, _ in
  // Write the whole buffer to stdout, then hand it back to the queue.
  var p = UnsafeRawPointer(buffer.pointee.mAudioData)
  var left = Int(buffer.pointee.mAudioDataByteSize)
  while left > 0 {
    let n = write(1, p, left)
    if n <= 0 { exit(0) }
    p = p.advanced(by: n)
    left -= n
  }
  AudioQueueEnqueueBuffer(queue, buffer, 0, nil)
}, nil, nil, nil, 0, &queue)
guard status == noErr, let q = queue else { fail("AudioQueueNewInput failed: \(status)") }

// The property value is a CFStringRef, so pass a pointer to the reference.
let cfUID = uid as CFString
var uidRef = Unmanaged.passUnretained(cfUID).toOpaque()
status = AudioQueueSetProperty(q, kAudioQueueProperty_CurrentDevice, &uidRef, UInt32(MemoryLayout<UnsafeMutableRawPointer>.size))
guard status == noErr else { fail("Couldn't select \(deviceName): \(status)") }

for _ in 0..<bufferCount {
  var buffer: AudioQueueBufferRef?
  guard AudioQueueAllocateBuffer(q, framesPerBuffer * bytesPerFrame, &buffer) == noErr, let b = buffer else {
    fail("AudioQueueAllocateBuffer failed")
  }
  AudioQueueEnqueueBuffer(q, b, 0, nil)
}

status = AudioQueueStart(q, nil)
guard status == noErr else { fail("AudioQueueStart failed: \(status) (Microphone permission?)") }
FileHandle.standardError.write("Capturing \(deviceName) at 48 kHz stereo s16le\n".data(using: .utf8)!)
dispatchMain()
