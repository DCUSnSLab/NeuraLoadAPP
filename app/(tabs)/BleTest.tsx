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
} from "react-native";
import { BleManager, Device, Characteristic, BleError } from "react-native-ble-plx";
import * as ExpoDevice from "expo-device";
import { Buffer } from "buffer";

// -----------------------------
// 1) BLE 관련 상수 (Python 코드 기준)
// -----------------------------
const SENSOR_SERVICE_UUID = "00000001-736c-4645-b520-7127aadf8c47";
const IMU_CHARACTERISTIC_UUID = "00000002-736c-4645-b520-7127aadf8c47";
const LASER_CHARACTERISTIC_UUID = "00000003-736c-4645-b520-7127aadf8c47";
const DEVICE_LOCAL_NAME = "NeuraLoad"; // 라즈베리 파이에서 광고하는 로컬 이름

/**
 * BLE를 통해 라즈베리 파이의 IMU / Laser 데이터를 수신하는 예시 화면
 * 파일 이름: BleTest.tsx
 */
const BleTest: React.FC = () => {
  // BLE Manager - 한 번만 생성
  const bleManager = useMemo(() => new BleManager(), []);

  // 스캔된 기기 목록
  const [allDevices, setAllDevices] = useState<Device[]>([]);
  // 현재 연결된 기기
  const [connectedDevice, setConnectedDevice] = useState<Device | null>(null);

  // 스캔 진행중 여부
  const [isScanning, setIsScanning] = useState<boolean>(false);

  // Python 코드에서 보내주는 IMU / Laser 데이터
  // IMU -> 24개 float
  const [imuData, setImuData] = useState<number[]>([]);
  // Laser -> 4개 float
  const [laserData, setLaserData] = useState<number[]>([]);

  // ----------------------------------------------------------------
  // 2) 안드로이드 12+ (API 31+)의 BLE 권한 처리 함수
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
        // Android 12 미만
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
      // iOS - Info.plist에서 NSBluetoothPeripheralUsageDescription 설정 필요
      return true;
    }
  }, [requestAndroid12Permissions]);

  // ----------------------------------------------------------------
  // 4) BLE 스캔 시작
  // ----------------------------------------------------------------
  const scanForDevices = useCallback(async () => {
    setIsScanning(true);
    bleManager.stopDeviceScan(); // 혹시 모를 중복 스캔 중지

    // 권한 확인
    const hasPermission = await requestPermissions();
    if (!hasPermission) {
      console.log("BLE Permissions not granted!");
      setIsScanning(false);
      return;
    }

    // 기존 목록 초기화 후 새로 스캔
    setAllDevices([]);
    bleManager.startDeviceScan(null, null, (error, device) => {
      if (error) {
        console.log("Scan error:", error);
        setIsScanning(false);
        return;
      }

      if (device?.name === DEVICE_LOCAL_NAME) {
        setAllDevices((prev) => {
          const idx = prev.findIndex((d) => d.id === device.id);
          if (idx === -1) {
            return [...prev, device];
          }
          return prev;
        });
      }
    });

    // 10초 후 스캔 중지
    setTimeout(() => {
      bleManager.stopDeviceScan();
      setIsScanning(false);
    }, 10000);
  }, [bleManager, requestPermissions]);

  // ----------------------------------------------------------------
  // 5) 선택한 기기에 연결
  // ----------------------------------------------------------------
  const connectToDevice = useCallback(
    async (device: Device) => {
      try {
        const connected = await bleManager.connectToDevice(device.id);
        setConnectedDevice(connected);

        // 연결 성공 후 서비스/특성 모두 검색
        await connected.discoverAllServicesAndCharacteristics();
        // 스캔 중지
        bleManager.stopDeviceScan();

        // IMU, Laser 특성에 대해 Notify 시작
        startNotifications(connected);
      } catch (error) {
        console.log("Connection error:", error);
      }
    },
    [bleManager]
  );

  // ----------------------------------------------------------------
  // 6) Notify(구독) 설정
  // ----------------------------------------------------------------
  const startNotifications = useCallback(
    async (device: Device) => {
      // IMUCharacteristic (24개 float)
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
  
          // base64 → Buffer
          const buffer = Buffer.from(characteristic.value, 'base64');
  
          // float32 (리틀 엔디안) 파싱
          const floats: number[] = [];
          for (let i = 0; i < buffer.length; i += 4) {
            floats.push(buffer.readFloatLE(i)); // 리틀 엔디안 float 읽기
          }
  
          // IMU: [AccelX, AccelY, AccelZ, GyroX, GyroY, GyroZ] * 4센서 = 24개
          setImuData(floats);
        }
      );
  
      // LaserCharacteristic (4개 float)
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
          console.log("Raw data (base64):", characteristic.value);
  
          // base64 → Buffer
          const buffer = Buffer.from(characteristic.value, 'base64');
          console.log("Buffer length:", buffer.length);
          console.log("Buffer (hex):", buffer.toString("hex"));
          console.log("Buffer as array:", Array.from(buffer));
          // float32 (리틀 엔디안) 파싱
          const floats: number[] = [];
          for (let i = 0; i < buffer.length; i += 4) {
            floats.push(buffer.readFloatLE(i)); // 리틀 엔디안 float 읽기
          }
  
          // Laser: 4개 float
          setLaserData(floats);
        }
      );
    },
    []
  );
  

  // ----------------------------------------------------------------
  // 7) 연결 해제
  // ----------------------------------------------------------------
  const disconnectDevice = useCallback(() => {
    if (connectedDevice) {
      bleManager.cancelDeviceConnection(connectedDevice.id).catch((err) => {
        console.log("Disconnection error:", err);
      });
      setConnectedDevice(null);
      setImuData([]);
      setLaserData([]);
    }
  }, [bleManager, connectedDevice]);

  // ----------------------------------------------------------------
  // (부가) Float 파싱 함수
  // ----------------------------------------------------------------
  /**
   * 4바이트 리틀 엔디안 → float32 변환
   */
  const byteArrayToFloat32 = (bytes: number[]): number => {
    // JS에서는 Float32Array + DataView 또는 Buffer를 사용해서 해석할 수 있습니다.
    // 여기서는 간단히 DataView를 통해 변환하는 방법:
    const buffer = new ArrayBuffer(4);
    const view = new DataView(buffer);
    // 리틀 엔디안으로 세팅
    bytes.forEach((b, i) => view.setUint8(i, b));
    return view.getFloat32(0, true);
  };

  // ----------------------------------------------------------------
  // 8) 언마운트 시 정리
  // ----------------------------------------------------------------
  useEffect(() => {
    return () => {
      //bleManager.stopDeviceScan();
      disconnectDevice();
      //bleManager.destroy();
    };
  }, [bleManager, disconnectDevice]);

  // ----------------------------------------------------------------
  // 9) UI
  // ----------------------------------------------------------------
  return (
    <View style={styles.container}>
      <Text style={styles.title}>BLE Test</Text>
      {!connectedDevice ? (
        <Button
          title={isScanning ? "Scanning..." : "Scan for device"}
          onPress={scanForDevices}
          disabled={isScanning}
        />
      ) : (
        <Button title="Disconnect" onPress={disconnectDevice} />
      )}

      {connectedDevice ? (
        <>
          <Text style={styles.subtitle}>
            Connected to: {connectedDevice.name || connectedDevice.id}
          </Text>
          <View style={{ marginTop: 16 }}>
            <Text style={styles.dataTitle}>IMU Data (24 floats)</Text>
            <Text style={styles.dataText}>
              {imuData.length > 0 ? imuData.join(", ") : "No IMU data yet"}
            </Text>
          </View>
          <View style={{ marginTop: 16 }}>
            <Text style={styles.dataTitle}>Laser Data (4 floats)</Text>
            <Text style={styles.dataText}>
              {laserData.length > 0 ? laserData.join(", ") : "No Laser data yet"}
            </Text>
          </View>
        </>
      ) : (
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
    fontSize: 22,
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
  dataTitle: {
    fontSize: 15,
    fontWeight: "700",
  },
  dataText: {
    fontSize: 13,
    marginTop: 8,
  },
});
