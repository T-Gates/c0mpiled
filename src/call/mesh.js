// Human Check 통화 — RTCPeerConnection·데이터 채널 관리 (브라우저 전용)
// 새로 들어온 사람이 기존 인원 각각에게 offer + 'ctl' 데이터 채널을 만든다. 기존 인원은 answer한다.
// signal payload: {kind:'offer'|'answer', sdp} | {kind:'ice', candidate}

export function createMesh({ localStream, sendSignal, onTrack, onMessage, onChannelOpen, onPeerState }) {
  /** @type {Map<string, {pc: RTCPeerConnection, dc: RTCDataChannel|null, pendingIce: any[], stream: MediaStream|null}>} */
  const peers = new Map();

  function makePeer(peerId) {
    const existing = peers.get(peerId);
    if (existing) return existing;
    const pc = new RTCPeerConnection({ iceServers: [] });
    const peer = { pc, dc: null, pendingIce: [], stream: null };
    peers.set(peerId, peer);

    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);

    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      sendSignal(peerId, { kind: 'ice', candidate: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => {
      const stream = e.streams && e.streams[0] ? e.streams[0] : (peer.stream || new MediaStream());
      if (!e.streams || !e.streams[0]) stream.addTrack(e.track);
      if (peer.stream !== stream) {
        peer.stream = stream;
      }
      onTrack && onTrack(peerId, stream);
    };
    pc.ondatachannel = (e) => {
      if (e.channel.label === 'ctl') wireChannel(peerId, peer, e.channel);
    };
    pc.onconnectionstatechange = () => {
      onPeerState && onPeerState(peerId, pc.connectionState);
    };
    return peer;
  }

  function wireChannel(peerId, peer, dc) {
    peer.dc = dc;
    dc.onopen = () => onChannelOpen && onChannelOpen(peerId);
    dc.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg && typeof msg.type === 'string') onMessage && onMessage(peerId, msg);
    };
    dc.onclose = () => onPeerState && onPeerState(peerId, 'channel-closed');
    if (dc.readyState === 'open') onChannelOpen && onChannelOpen(peerId);
  }

  async function flushIce(peer) {
    const list = peer.pendingIce;
    peer.pendingIce = [];
    for (const c of list) {
      try {
        await peer.pc.addIceCandidate(c);
      } catch (e) {
        console.warn('ICE 후보 추가 실패', e);
      }
    }
  }

  // 새로 들어온 쪽: 기존 인원에게 연결 시작
  async function connectTo(peerId) {
    const peer = makePeer(peerId);
    wireChannel(peerId, peer, peer.pc.createDataChannel('ctl', { ordered: true }));
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    sendSignal(peerId, { kind: 'offer', sdp: peer.pc.localDescription.sdp });
  }

  // 신호는 도착 순서대로 하나씩 처리한다 (offer 처리 중 도착한 ICE가 순서를 앞지르지 않도록)
  let queue = Promise.resolve();
  function handleSignal(from, payload) {
    queue = queue
      .then(() => processSignal(from, payload))
      .catch((e) => console.warn('신호 처리 실패', from, payload && payload.kind, e));
    return queue;
  }

  async function processSignal(from, payload) {
    if (!payload || typeof payload.kind !== 'string') return;
    if (payload.kind === 'offer') {
      const peer = makePeer(from);
      await peer.pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
      await flushIce(peer);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      sendSignal(from, { kind: 'answer', sdp: peer.pc.localDescription.sdp });
    } else if (payload.kind === 'answer') {
      const peer = peers.get(from);
      if (!peer || peer.pc.signalingState !== 'have-local-offer') return;
      await peer.pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
      await flushIce(peer);
    } else if (payload.kind === 'ice') {
      if (!payload.candidate) return;
      // remote description이 아직 없으면 버퍼에 쌓았다가 설정 직후 추가한다
      const peer = peers.get(from) || makePeer(from);
      if (peer.pc.remoteDescription) {
        try {
          await peer.pc.addIceCandidate(payload.candidate);
        } catch (e) {
          console.warn('ICE 후보 추가 실패', e);
        }
      } else {
        peer.pendingIce.push(payload.candidate);
      }
    }
  }

  function send(peerId, msg) {
    const peer = peers.get(peerId);
    if (!peer || !peer.dc || peer.dc.readyState !== 'open') return false;
    try {
      peer.dc.send(JSON.stringify(msg));
      return true;
    } catch (e) {
      console.warn('데이터 채널 전송 실패', e);
      return false;
    }
  }

  function broadcast(msg) {
    for (const id of peers.keys()) send(id, msg);
  }

  function isOpen(peerId) {
    const peer = peers.get(peerId);
    return Boolean(peer && peer.dc && peer.dc.readyState === 'open');
  }

  function remove(peerId) {
    const peer = peers.get(peerId);
    if (!peer) return;
    peers.delete(peerId);
    try {
      if (peer.dc) peer.dc.close();
    } catch {}
    try {
      peer.pc.close();
    } catch {}
  }

  function closeAll() {
    for (const id of [...peers.keys()]) remove(id);
  }

  return { connectTo, handleSignal, send, broadcast, isOpen, remove, closeAll, peers };
}
