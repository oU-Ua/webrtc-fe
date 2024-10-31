// 비디오 요소
let localStreamElement = document.querySelector("#localStream");
let screenStreamElement = document.querySelector("#screenStream");
const myKey = Math.random().toString(36).substring(2, 11);

//PeerConnection 객체를 저장하는 Map
let pcListMap = new Map();
let roomId;

//다른 사용자들의 myKey 목록
let otherKeyList = [];
let localStream = undefined;
let screenStream = undefined;

//웹캠과 마이크 설정
const startCam = async () => {
  if (navigator.mediaDevices !== undefined) {
    //사용자의 웹캠과 마이크 요청
    await navigator.mediaDevices
      .getUserMedia({ audio: true, video: true })
      .then(async (stream) => {
        console.log("Stream found");

        //웹캠, 마이크의 스트림 정보를 글로벌 변수에 저장
        localStream = stream;
        //마이크 활성화
        stream.getAudioTracks()[0].enabled = true;

        // 비디오 요소에 해당 stream을 연결
        localStreamElement.srcObject = localStream;
      })
      .catch((error) => {
        console.error("Error accessing media devices:", error);
      });
  }
};

// 화면 공유 시작 함수
const startScreenShare = async () => {
  try {
    console.log("Screen sharing started.");
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true, // 공유 화면의 오디오 포함
    });

    console.log("Screen connected.");
    screenStreamElement.srcObject = screenStream;

    stompClient.send(
      `/app/peer/shareScreen/${roomId}`,
      {},
      JSON.stringify({
        key: myKey,
        screenStream: screenStream,
        message: `shareScreen ${myKey}`,
      })
    );

    // 화면 공유 중지 시 이벤트 핸들러 추가
    screenStream.getVideoTracks()[0].onended = () => {
      console.log("Screen sharing stopped.");
      stopScreenShare();
    };
  } catch (error) {
    console.error("Error sharing screen:", error);
  }
};

// 화면 공유 중지 함수 (수정)
const stopScreenShare = () => {
  if (screenStream) {
    screenStream.getTracks().forEach((track) => track.stop());

    // 각 피어에서 화면 공유 트랙 제거
    pcListMap.forEach((pc, key) => {
      const senders = pc
        .getSenders()
        .filter((sender) => sender.track.kind === "video");
      senders.forEach((sender) => pc.removeTrack(sender));
    });

    screenStream = null;
    console.log("Screen share stopped.");
  }
};

// 소켓 연결
const connectSocket = async () => {
  const socket = new SockJS(
    "http://ec2-3-35-49-10.ap-northeast-2.compute.amazonaws.com:8080/consulting-room"
  );
  stompClient = Stomp.over(socket);
  stompClient.debug = null;

  stompClient.connect({}, function () {
    console.log("Connected to WebRTC server");

    stompClient.subscribe(`/topic/peer/shareScreen/${roomId}`, (message) => {
      const { screenStream: shareScreenStream } = JSON.parse(message.body);
      console.log(` ${shareScreenStream} screen shared`);

      screenStreamElement.srcObject = screenStream;
    });

    stompClient.subscribe(`/topic/peer/disconnect/${roomId}`, (message) => {
      const { key: disconnectedKey } = JSON.parse(message.body);
      console.log(`User ${disconnectedKey} disconnected`);

      const videoElement = document.getElementById(disconnectedKey);
      if (videoElement && videoElement.parentNode) {
        videoElement.parentNode.removeChild(videoElement);
      }

      pcListMap.delete(disconnectedKey);
      otherKeyList = otherKeyList.filter((key) => key !== disconnectedKey);
    });

    //iceCandidate peer 교환을 위한 subscribe
    stompClient.subscribe(
      `/topic/peer/iceCandidate/${myKey}/${roomId}`,
      (candidate) => {
        const key = JSON.parse(candidate.body).key;
        const message = JSON.parse(candidate.body).body;

        // 해당 key에 해당되는 peer 에 받은 정보를 addIceCandidate 해준다.
        pcListMap.get(key).addIceCandidate(
          new RTCIceCandidate({
            candidate: message.candidate,
            sdpMLineIndex: message.sdpMLineIndex,
            sdpMid: message.sdpMid,
          })
        );
      }
    );

    //offer peer 교환을 위한 subscribe
    stompClient.subscribe(`/topic/peer/offer/${myKey}/${roomId}`, (offer) => {
      const key = JSON.parse(offer.body).key;
      const message = JSON.parse(offer.body).body;

      // 해당 key에 새로운 peerConnection 를 생성해준후 pcListMap 에 저장해준다.
      pcListMap.set(key, createPeerConnection(key));
      // 생성한 peer 에 offer정보를 setRemoteDescription 해준다.
      pcListMap
        .get(key)
        .setRemoteDescription(
          new RTCSessionDescription({ type: message.type, sdp: message.sdp })
        );
      //sendAnswer 함수를 호출해준다.
      sendAnswer(pcListMap.get(key), key);
    });

    //answer peer 교환을 위한 subscribe
    stompClient.subscribe(`/topic/peer/answer/${myKey}/${roomId}`, (answer) => {
      const key = JSON.parse(answer.body).key;
      const message = JSON.parse(answer.body).body;

      // 해당 key에 해당되는 Peer 에 받은 정보를 setRemoteDescription 해준다.
      pcListMap
        .get(key)
        .setRemoteDescription(new RTCSessionDescription(message));
    });

    //key를 보내라는 신호를 받은 subscribe
    stompClient.subscribe(`/topic/call/key`, (message) => {
      //자신의 key를 보내는 send
      stompClient.send(`/app/send/key`, {}, JSON.stringify(myKey));
    });

    //상대방의 key를 받는 subscribe
    stompClient.subscribe(`/topic/send/key`, (message) => {
      const key = JSON.parse(message.body);

      //만약 중복되는 키가 ohterKeyList에 있는지 확인하고 없다면 추가해준다.
      if (
        myKey !== key &&
        otherKeyList.find((mapKey) => mapKey === myKey) === undefined
      ) {
        otherKeyList.push(key);
      }
    });
  });
};

let onTrack = (event, otherKey) => {
  if (document.getElementById(`${otherKey}`) === null) {
    const video = document.createElement("video");

    video.autoplay = true;
    video.controls = true;
    video.id = otherKey;
    video.srcObject = event.streams[0];

    document.getElementById("remoteStreamDiv").appendChild(video);
  }

  //
  // remoteStreamElement.srcObject = event.streams[0];
  // remoteStreamElement.play();
};

const createPeerConnection = (otherKey) => {
  const pc = new RTCPeerConnection();
  try {
    pc.addEventListener("icecandidate", (event) => {
      onIceCandidate(event, otherKey);
    });
    pc.addEventListener("track", (event) => {
      onTrack(event, otherKey);
    });
    if (localStream !== undefined) {
      localStream.getTracks().forEach((track) => {
        pc.addTrack(track, localStream);
      });
    }
    if (screenStream !== undefined) {
      screenStream.getTracks().forEach((track) => {
        pc.addTrack(track, screenStream);
      });
    }

    console.log("PeerConnection created");
    pc.oniceconnectionstatechange = () => {
      if (
        pc.iceConnectionState === "disconnected" ||
        pc.iceConnectionState === "failed" ||
        pc.iceConnectionState === "closed"
      ) {
        // 해당 피어의 비디오를 DOM에서 제거
        const videoElement = document.getElementById(
          `peer_${pc.remoteDescription.sdpMid}`
        );
        if (videoElement) {
          videoElement.remove();
          console.log("Disconnected peer video removed.");
        }
      }
    };
  } catch (error) {
    console.error("PeerConnection failed: ", error);
  }
  return pc;
};

let onIceCandidate = (event, otherKey) => {
  if (event.candidate) {
    console.log("ICE candidate");
    stompClient.send(
      `/app/peer/iceCandidate/${otherKey}/${roomId}`,
      {},
      JSON.stringify({
        key: myKey,
        body: event.candidate,
      })
    );
  }
};

let sendOffer = (pc, otherKey) => {
  pc.createOffer().then((offer) => {
    setLocalAndSendMessage(pc, offer);
    stompClient.send(
      `/app/peer/offer/${otherKey}/${roomId}`,
      {},
      JSON.stringify({
        key: myKey,
        body: offer,
      })
    );
    console.log("Send offer");
  });
};

let sendAnswer = (pc, otherKey) => {
  pc.createAnswer().then((answer) => {
    setLocalAndSendMessage(pc, answer);
    stompClient.send(
      `/app/peer/answer/${otherKey}/${roomId}`,
      {},
      JSON.stringify({
        key: myKey,
        body: answer,
      })
    );
    console.log("Send answer");
  });
};

const setLocalAndSendMessage = (pc, sessionDescription) => {
  pc.setLocalDescription(sessionDescription);
};

//룸 번호 입력 후 캠 + 웹소켓 실행
document.querySelector("#enterRoomBtn").addEventListener("click", async () => {
  await startCam();

  if (localStream !== undefined) {
    document.querySelector("#localStream").style.display = "block";
    document.querySelector("#startSteamBtn").style.display = "";
  }
  roomId = document.querySelector("#roomIdInput").value;
  document.querySelector("#roomIdInput").disabled = true;
  document.querySelector("#enterRoomBtn").disabled = true;

  await connectSocket();
});

// 스트림 버튼 클릭시 , 다른 웹 key들 웹소켓을 가져 온뒤에 offer -> answer -> iceCandidate 통신
// peer 커넥션은 pcListMap 으로 저장
document.querySelector("#startSteamBtn").addEventListener("click", async () => {
  await stompClient.send(`/app/call/key`, {}, {});

  setTimeout(() => {
    otherKeyList.map((key) => {
      if (!pcListMap.has(key)) {
        pcListMap.set(key, createPeerConnection(key));
        sendOffer(pcListMap.get(key), key);
      }
    });
  }, 1000);
});
document
  .querySelector("#finishStreamBtn")
  .addEventListener("click", async () => {
    stompClient.send(
      `/app/peer/disconnect/${roomId}`,
      {},
      JSON.stringify({
        key: myKey,
        message: `${myKey} is leaving the room`,
      })
    );

    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
      localStreamElement.srcObject = null;
    }

    // Close all peer connections
    pcListMap.forEach((pc, key) => pc.close());
    pcListMap.clear();

    console.log("Disconnected from the room.");
  });
document
  .querySelector("#shareScreenBtn")
  .addEventListener("click", async () => {
    console.log("Preparing to share screen...");
    await startScreenShare();
  });
