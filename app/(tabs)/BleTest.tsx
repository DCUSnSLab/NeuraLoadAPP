/* eslint-disable no-bitwise */
import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  View,
  Text,
  Button,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Platform,
  PermissionsAndroid,
  ScrollView,
} from "react-native";
import { BleManager, Device, Characteristic, BleError } from "react-native-ble-plx";
import * as ExpoDevice from "expo-device";
import { Buffer } from "buffer";

// -----------------------------
// 1) BLE 관련 상수 (Python 코드 기준)
// -----------------------------
const SENSOR_SERVICE_UUID = "00000001-736c-4645-b520-7127aadf8c47";

// Characteristic UUID들
const IMU_CHARACTERISTIC_UUID = "00000002-736c-4645-b520-7127aadf8c47";    // 36 floats
const LASER_CHARACTERISTIC_UUID = "00000003-736c-4645-b520-7127aadf8c47";  // 4 floats
const WEIGHT_CHARACTERISTIC_UUID = "00000004-736c-4645-b520-7127aadf8c47"; // 1 float
const DEVICE_ID_CHARACTERISTIC_UUID = "00000005-736c-4645-b520-7127aadf8c47"; // 문자열

// 라즈베리 파이가 광고하는 로컬 이름
const DEVICE_LOCAL_NAME = "NeuraLoad";

/**
 * BLE를 통해 라즈베리 파이의
 * - IMU(4x9 floats)
 * - Laser(4 floats)
 * - Weight(1 float)
 * - Device ID(문자열)
 * 데이터를 받아서 표시하는 예시 화면
 */
const BleTest: React.FC = () => {
  // ----------------------------------------
  // BLE Manager - 한 번만 생성
  // ----------------------------------------
  const bleManager = useMemo(() => new BleManager(), []);

  // ----------------------------------------
  // State
  // ----------------------------------------
  // 스캔된 기기 목록
  const [allDevices, setAllDevices] = useState<Device[]>([]);
  // 현재 연결된 기기
  const [connectedDevice, setConnectedDevice] = useState<Device | null>(null);
  // 스캔 진행중 여부
  const [isScanning, setIsScanning] = useState<boolean>(false);

  // ---- 센서 데이터 ----
  // IMU -> 36개 float (4센서 × 9개)
  const [imuData, setImuData] = useState<number[]>([]);
  // Laser -> 4개 float
  const [laserData, setLaserData] = useState<number[]>([]);
  // Weight -> 1개 float
  const [weightData, setWeightData] = useState<number>(0);
  // Device ID -> 문자열
  const [deviceID, setDeviceID] = useState<string>("N/A");

  // ----------------------------------------------------------------
  // 2) Android 12+ (API 31+) 권한 요청
  // ----------------------------------------------------------------
  const requestAndroid12Permissions = useCallback(async () => {
    const bluetoothScanPermission = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      {
        title: "Bluetooth Scan Permission",
        message: "This app requires Bluetooth scan permission",
        buttonPositive: "OK",
      }
    );
    const bluetoothConnectPermission = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      {
        title: "Bluetooth Connect Permission",
        message: "This app requires Bluetooth connect permission",
        buttonPositive: "OK",
      }
    );
    const fineLocationPermission = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      {
        title: "Fine Location Permission",
        message: "BLE requires Fine Location permission",
        buttonPositive: "OK",
      }
    );

    return (
      bluetoothScanPermission === PermissionsAndroid.RESULTS.GRANTED &&
      bluetoothConnectPermission === PermissionsAndroid.RESULTS.GRANTED &&
      fineLocationPermission === PermissionsAndroid.RESULTS.GRANTED
    );
  }, []);

  // ----------------------------------------------------------------
  // 3) 플랫폼별 권한 요청
  // ----------------------------------------------------------------
  const requestPermissions = useCallback(async (): Promise<boolean> => {
    if (Platform.OS === "android") {
      const apiLevel = ExpoDevice.platformApiLevel ?? -1;

      if (apiLevel < 31) {
        // Android 12 미만 -> ACCESS_FINE_LOCATION
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          {
            title: "Location Permission",
            message: "BLE requires Location permission",
            buttonPositive: "OK",
          }
        );
        return granted === PermissionsAndroid.RESULTS.GRANTED;
      } else {
        // Android 12 이상
        return await requestAndroid12Permissions();
      }
    } else {
      // iOS - Info.plist에서 NSBluetoothPeripheralUsageDescription 필요
      return true;
    }
  }, [requestAndroid12Permissions]);

  // ----------------------------------------------------------------
  // 4) BLE 스캔 시작
  // ----------------------------------------------------------------
  const scanForDevices = useCallback(async () => {
    setIsScanning(true);
    bleManager.stopDeviceScan(); // 기존 스캔 중지

    // 권한 확인
    const hasPermission = await requestPermissions();
    if (!hasPermission) {
      console.log("BLE Permissions not granted!");
      setIsScanning(false);
      return;
    }

    // 스캔 목록 초기화
    setAllDevices([]);
    bleManager.startDeviceScan(null, null, (error, device) => {
      if (error) {
        console.log("Scan error:", error);
        setIsScanning(false);
        return;
      }

      // 장치 이름이 "NeuraLoad" 인지 확인
      if (device?.name === DEVICE_LOCAL_NAME) {
        // 중복 체크
        setAllDevices((prev) => {
          const alreadyInList = prev.findIndex((d) => d.id === device.id) >= 0;
          if (!alreadyInList) {
            return [...prev, device];
          }
          return prev;
        });
      }
    });
    
    // 10초 후 스캔 중단
    setTimeout(() => {
      bleManager.stopDeviceScan();
      setIsScanning(false);
    }, 10000);
  }, [bleManager, requestPermissions]);

  // ----------------------------------------------------------------
  // 5) 기기에 연결
  // ----------------------------------------------------------------
  const connectToDevice = useCallback(
    async (device: Device) => {
      try {
        const connected = await bleManager.connectToDevice(device.id);
        setConnectedDevice(connected);

        // 연결 성공 후, 서비스/특성 검색
        await connected.discoverAllServicesAndCharacteristics();
        bleManager.stopDeviceScan();

        // Notify 등록 (IMU, Laser, Weight)
        startNotifications(connected);

        // Device ID (문자열) Read (Notify로도 가능하지만, 여기선 단일 Read 예시)
        readDeviceID(connected);
      } catch (error) {
        console.log("Connection error:", error);
      }
    },
    [bleManager]
  );

  // ----------------------------------------------------------------
  // 6-A) Notify(구독) 설정 (IMU, Laser, Weight)
  // ----------------------------------------------------------------
  const startNotifications = useCallback(async (device: Device) => {
    // IMU (36 floats)
    device.monitorCharacteristicForService(
      SENSOR_SERVICE_UUID,
      IMU_CHARACTERISTIC_UUID,
      (error: BleError | null, characteristic: Characteristic | null) => {
        if (error) {
          console.log("IMU Notify Error:", error);
          return;
        }
        if (!characteristic?.value) {
          return;
        }
        console.log("[IMU] Raw data (base64):", characteristic.value);
        // base64 → Buffer
        const buffer = Buffer.from(characteristic.value, "base64");
        console.log("[IMU] Buffer length:", buffer.length);
        console.log("[IMU] Buffer (hex):", buffer.toString("hex"));
        console.log("[IMU] Buffer as array:", Array.from(buffer));
        
        // float32 (리틀 엔디안) 파싱
        // 총 36개의 float
        const floats: number[] = [];
        for (let i = 0; i < buffer.length; i += 4) {
          floats.push(buffer.readFloatLE(i));
        }
        setImuData(floats);
      }
    );

    // Laser (4 floats)
    device.monitorCharacteristicForService(
      SENSOR_SERVICE_UUID,
      LASER_CHARACTERISTIC_UUID,
      (error: BleError | null, characteristic: Characteristic | null) => {
        if (error) {
          console.log("Laser Notify Error:", error);
          return;
        }
        if (!characteristic?.value) {
          return;
        }
        const buffer = Buffer.from(characteristic.value, "base64");
        const floats: number[] = [];
        for (let i = 0; i < buffer.length; i += 4) {
          floats.push(buffer.readFloatLE(i));
        }
        setLaserData(floats);
      }
    );

    // Weight (1 float)
    device.monitorCharacteristicForService(
      SENSOR_SERVICE_UUID,
      WEIGHT_CHARACTERISTIC_UUID,
      (error: BleError | null, characteristic: Characteristic | null) => {
        if (error) {
          console.log("Weight Notify Error:", error);
          return;
        }
        if (!characteristic?.value) {
          return;
        }
        const buffer = Buffer.from(characteristic.value, "base64");
        // Weight는 float 1개
        if (buffer.length >= 4) {
          const w = buffer.readFloatLE(0);
          setWeightData(w);
        }
      }
    );
  }, []);

  // ----------------------------------------------------------------
  // 6-B) Device ID (문자열) 읽기
  // ----------------------------------------------------------------
  const readDeviceID = useCallback(async (device: Device) => {
    try {
      const characteristic = await device.readCharacteristicForService(
        SENSOR_SERVICE_UUID,
        DEVICE_ID_CHARACTERISTIC_UUID
      );
      if (characteristic?.value) {
        // base64 → Buffer → 문자열(UTF-8)
        const buffer = Buffer.from(characteristic.value, "base64");
        const idStr = buffer.toString("utf-8");
        setDeviceID(idStr);
      }
    } catch (err) {
      console.log("Read Device ID error:", err);
    }
  }, []);

  // ----------------------------------------------------------------
  // 7) 연결 해제
  // ----------------------------------------------------------------
  const disconnectDevice = useCallback(() => {
    if (connectedDevice) {
      bleManager
        .cancelDeviceConnection(connectedDevice.id)
        .catch((err) => console.log("Disconnection error:", err));
      setConnectedDevice(null);
      // 데이터 초기화
      setImuData([]);
      setLaserData([]);
      setWeightData(0);
      setDeviceID("N/A");
    }
  }, [bleManager, connectedDevice]);

  // ----------------------------------------------------------------
  // 8) 언마운트 시 정리
  // ----------------------------------------------------------------
  useEffect(() => {
    return () => {
      // 필요 시 stopDeviceScan() 등 처리
      disconnectDevice();
      // bleManager.destroy(); // 재사용할 경우 주석 처리
    };
  }, [disconnectDevice]);

  // ----------------------------------------
  // IMU 데이터 파싱 후, 4x9 로 묶어서 리턴
  // ----------------------------------------
  const getImuMatrix = useCallback(() => {
    // IMU가 36개 float
    // 센서 4개, 각 9개 값
    const matrix: number[][] = [];
    for (let i = 0; i < imuData.length; i += 9) {
      matrix.push(imuData.slice(i, i + 9));
    }
    // 결과: [[s1(9개)], [s2(9개)], [s3(9개)], [s4(9개)]]
    return matrix;
  }, [imuData]);

  // ----------------------------------------------------------------
  // 9) UI
  // ----------------------------------------------------------------
  // IMU 라벨
  const imuLabels = [
    "AccelX", "AccelY", "AccelZ",
    "GyroX", "GyroY", "GyroZ",
    "MagX",  "MagY",  "MagZ",
  ];

  return (
    <View style={styles.container}>
      <Text style={styles.title}>BLE Test (IMU, Laser, Weight, DeviceID)</Text>

      {/* 스캔/연결 버튼 */}
      {!connectedDevice ? (
        <Button
          title={isScanning ? "Scanning..." : "Scan for NeuraLoad"}
          onPress={scanForDevices}
          disabled={isScanning}
        />
      ) : (
        <Button title="Disconnect" onPress={disconnectDevice} />
      )}

      {/* 연결된 기기 정보 + 센서 데이터 */}
      {connectedDevice ? (
        <ScrollView style={{ marginTop: 16 }}>
          <Text style={styles.subtitle}>
            Connected to: {connectedDevice.name || connectedDevice.id}
          </Text>

          {/* Device ID */}
          <View style={styles.dataBlock}>
            <Text style={styles.dataTitle}>Device ID</Text>
            <Text style={styles.dataText}>{deviceID}</Text>
          </View>

          {/* IMU */}
          <View style={styles.dataBlock}>
            <Text style={styles.dataTitle}>IMU Data (4 sensors × 9 floats each)</Text>
            {imuData.length === 36 ? (
              getImuMatrix().map((sensorVals, sIdx) => (
                <View key={`imu-sensor-${sIdx}`} style={styles.imuSensorBlock}>
                  <Text style={styles.imuSensorTitle}>IMU Sensor #{sIdx + 1}</Text>
                  {sensorVals.map((val, idx) => (
                    <Text style={styles.imuSensorItem} key={`imu-${sIdx}-${idx}`}>
                      {imuLabels[idx]}: {val.toFixed(3)}
                    </Text>
                  ))}
                </View>
              ))
            ) : (
              <Text>No IMU data yet.</Text>
            )}
          </View>

          {/* Laser */}
          <View style={styles.dataBlock}>
            <Text style={styles.dataTitle}>Laser Data (4 floats)</Text>
            {laserData.length === 4 ? (
              laserData.map((val, idx) => (
                <Text key={`laser-${idx}`} style={styles.imuSensorItem}>
                  Laser #{idx + 1}: {val.toFixed(3)}
                </Text>
              ))
            ) : (
              <Text>No Laser data yet.</Text>
            )}
          </View>

          {/* Weight */}
          <View style={styles.dataBlock}>
            <Text style={styles.dataTitle}>Estimated Weight (1 float)</Text>
            <Text style={styles.imuSensorItem}>
              {weightData !== 0 ? `${weightData.toFixed(2)} kg` : "No Weight data yet."}
            </Text>
          </View>
        </ScrollView>
      ) : (
        // 스캔된 장치 목록
        <View style={styles.listContainer}>
          <Text style={styles.subtitle}>Scanned Devices</Text>
          {allDevices.length === 0 && <Text>No devices found</Text>}
          <FlatList
            data={allDevices}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={styles.deviceItem}
                onPress={() => connectToDevice(item)}
              >
                <Text style={styles.deviceText}>
                  {item.name || "Unnamed"} ({item.id})
                </Text>
              </TouchableOpacity>
            )}
          />
        </View>
      )}
    </View>
  );
};

export default BleTest;

// ----------------------------------------------------------------
// 10) 스타일
// ----------------------------------------------------------------
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#ffffff",
    paddingTop: 60,
    paddingHorizontal: 20,
  },
  title: {
    fontSize: 20,
    fontWeight: "600",
    textAlign: "center",
    marginBottom: 16,
  },
  subtitle: {
    fontSize: 16,
    fontWeight: "600",
    marginTop: 16,
  },
  listContainer: {
    marginTop: 16,
    flex: 1,
  },
  deviceItem: {
    padding: 12,
    backgroundColor: "#eee",
    marginVertical: 5,
    borderRadius: 6,
  },
  deviceText: {
    fontSize: 14,
  },
  dataBlock: {
    marginTop: 20,
    padding: 10,
    backgroundColor: "#f9f9f9",
    borderRadius: 8,
  },
  dataTitle: {
    fontSize: 15,
    fontWeight: "700",
    marginBottom: 8,
  },
  dataText: {
    fontSize: 14,
    marginTop: 4,
  },
  imuSensorBlock: {
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 5,
    padding: 8,
    backgroundColor: "#fff",
  },
  imuSensorTitle: {
    fontWeight: "600",
    marginBottom: 4,
  },
  imuSensorItem: {
    fontSize: 14,
    marginLeft: 8,
  },
});
