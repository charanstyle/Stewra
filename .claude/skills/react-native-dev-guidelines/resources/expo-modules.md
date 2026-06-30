# Expo Modules

Complete guide to commonly used Expo modules in React Native applications.

---

## Table of Contents

- [Camera](#camera)
- [Image Picker](#image-picker)
- [Notifications](#notifications)
- [Haptics](#haptics)
- [Other Useful Modules](#other-useful-modules)

---

## Camera

Access device camera for taking photos and videos.

### Basic Camera Setup

```typescript
import { Camera, CameraType } from 'expo-camera';
import { useState, useEffect } from 'react';
import { Button, StyleSheet, View, Text } from 'react-native';

export const CameraScreen: React.FC = () => {
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [type, setType] = useState(CameraType.back);

  useEffect(() => {
    (async () => {
      const { status } = await Camera.requestCameraPermissionsAsync();
      setHasPermission(status === 'granted');
    })();
  }, []);

  if (hasPermission === null) {
    return <View />;
  }

  if (hasPermission === false) {
    return <Text>No access to camera</Text>;
  }

  return (
    <View style={styles.container}>
      <Camera style={styles.camera} type={type}>
        <View style={styles.buttonContainer}>
          <Button
            title="Flip Camera"
            onPress={() => {
              setType(
                type === CameraType.back
                  ? CameraType.front
                  : CameraType.back
              );
            }}
          />
        </View>
      </Camera>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  camera: {
    flex: 1,
  },
  buttonContainer: {
    flex: 1,
    backgroundColor: 'transparent',
    justifyContent: 'flex-end',
    marginBottom: 36,
  },
});
```

### Take Photo

```typescript
import { Camera, CameraType } from 'expo-camera';
import { useRef, useState } from 'react';

export const CameraScreen: React.FC = () => {
  const cameraRef = useRef<Camera>(null);
  const [photo, setPhoto] = useState<string | null>(null);

  const takePicture = async () => {
    if (cameraRef.current) {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.8,
        base64: false,
        exif: false,
      });
      setPhoto(photo.uri);
    }
  };

  return (
    <View style={styles.container}>
      <Camera ref={cameraRef} style={styles.camera} type={CameraType.back}>
        <Button title="Take Photo" onPress={takePicture} />
      </Camera>
      {photo && <Image source={{ uri: photo }} style={styles.preview} />}
    </View>
  );
};
```

---

## Image Picker

Select images and videos from device library.

### Basic Image Picker

```typescript
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Button, Image, View, StyleSheet } from 'react-native';

export const ImagePickerExample: React.FC = () => {
  const [image, setImage] = useState<string | null>(null);

  const pickImage = async () => {
    // Request permission
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      alert('Sorry, we need camera roll permissions!');
      return;
    }

    // Launch image picker
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [4, 3],
      quality: 0.8,
    });

    if (!result.canceled) {
      setImage(result.assets[0].uri);
    }
  };

  return (
    <View style={styles.container}>
      <Button title="Pick an image" onPress={pickImage} />
      {image && <Image source={{ uri: image }} style={styles.image} />}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: {
    width: 200,
    height: 200,
    marginTop: 20,
  },
});
```

### Multiple Images

```typescript
const pickMultipleImages = async () => {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    allowsMultipleSelection: true,
    quality: 0.8,
  });

  if (!result.canceled) {
    const uris = result.assets.map(asset => asset.uri);
    setImages(uris);
  }
};
```

### Video Picker

```typescript
const pickVideo = async () => {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Videos,
    allowsEditing: true,
    quality: 1,
  });

  if (!result.canceled) {
    setVideo(result.assets[0].uri);
  }
};
```

---

## Notifications

Handle push notifications and local notifications.

### Setup Notifications

```typescript
import * as Notifications from 'expo-notifications';
import { useEffect, useRef } from 'react';

// Configure notification behavior
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export function useNotifications() {
  const notificationListener = useRef<Notifications.Subscription>();
  const responseListener = useRef<Notifications.Subscription>();

  useEffect(() => {
    // Request permissions
    registerForPushNotificationsAsync();

    // Listen for incoming notifications
    notificationListener.current = Notifications.addNotificationReceivedListener(
      notification => {
        console.log('Notification received:', notification);
      }
    );

    // Listen for notification responses (user tapped notification)
    responseListener.current = Notifications.addNotificationResponseReceivedListener(
      response => {
        console.log('Notification response:', response);
      }
    );

    return () => {
      if (notificationListener.current) {
        Notifications.removeNotificationSubscription(notificationListener.current);
      }
      if (responseListener.current) {
        Notifications.removeNotificationSubscription(responseListener.current);
      }
    };
  }, []);
}
```

### Request Permissions

```typescript
async function registerForPushNotificationsAsync() {
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') {
    alert('Failed to get push token for push notification!');
    return;
  }

  const token = (await Notifications.getExpoPushTokenAsync()).data;
  console.log('Push token:', token);

  return token;
}
```

### Schedule Local Notification

```typescript
const scheduleNotification = async (title: string, body: string) => {
  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      data: { data: 'goes here' },
      sound: true,
    },
    trigger: { seconds: 2 },
  });
};

// Schedule for specific time
const scheduleAtTime = async () => {
  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'Reminder',
      body: 'Time to check your tasks!',
    },
    trigger: {
      hour: 9,
      minute: 0,
      repeats: true,
    },
  });
};
```

### Cancel Notifications

```typescript
// Cancel specific notification
await Notifications.cancelScheduledNotificationAsync(notificationId);

// Cancel all scheduled notifications
await Notifications.cancelAllScheduledNotificationsAsync();
```

---

## Haptics

Provide haptic feedback for better user experience.

### Impact Feedback

```typescript
import * as Haptics from 'expo-haptics';

// Light impact
Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

// Medium impact
Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

// Heavy impact
Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
```

### Selection Feedback

```typescript
// For picker/selector changes
Haptics.selectionAsync();
```

### Notification Feedback

```typescript
// Success
Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

// Warning
Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);

// Error
Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
```

### Button with Haptics

```typescript
<Pressable
  onPress={() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    handlePress();
  }}
  style={styles.button}
>
  <Text>Press me</Text>
</Pressable>
```

---

## Other Useful Modules

### Expo Image (Optimized)

```typescript
import { Image } from 'expo-image';

<Image
  source={{ uri: 'https://example.com/image.jpg' }}
  style={styles.image}
  contentFit="cover"
  transition={1000}
  placeholder={blurhash}
/>
```

### Clipboard

```typescript
import * as Clipboard from 'expo-clipboard';

// Copy to clipboard
await Clipboard.setStringAsync('Hello World');

// Read from clipboard
const text = await Clipboard.getStringAsync();
```

### Sharing

```typescript
import * as Sharing from 'expo-sharing';

const share = async () => {
  const isAvailable = await Sharing.isAvailableAsync();
  if (isAvailable) {
    await Sharing.shareAsync(fileUri, {
      dialogTitle: 'Share this file',
    });
  }
};
```

### File System

```typescript
import * as FileSystem from 'expo-file-system';

// Download file
const downloadFile = async (url: string) => {
  const fileUri = FileSystem.documentDirectory + 'file.pdf';
  const downloadResult = await FileSystem.downloadAsync(url, fileUri);
  return downloadResult.uri;
};

// Read file
const readFile = async (fileUri: string) => {
  const content = await FileSystem.readAsStringAsync(fileUri);
  return content;
};

// Write file
const writeFile = async (fileUri: string, content: string) => {
  await FileSystem.writeAsStringAsync(fileUri, content);
};
```

### Audio

```typescript
import { Audio } from 'expo-av';

const playSound = async () => {
  const { sound } = await Audio.Sound.createAsync(
    require('./assets/sound.mp3')
  );
  await sound.playAsync();
};
```

### Linear Gradient

```typescript
import { LinearGradient } from 'expo-linear-gradient';

<LinearGradient
  colors={['#4c669f', '#3b5998', '#192f6a']}
  style={styles.gradient}
>
  <Text>Gradient Background</Text>
</LinearGradient>
```

### Blur View

```typescript
import { BlurView } from 'expo-blur';

<BlurView intensity={80} style={styles.blur}>
  <Text>Content with blur background</Text>
</BlurView>
```

---

## Best Practices

1. **Request Permissions**: Always request permissions before accessing device features
2. **Check Availability**: Check if features are available before using them
3. **Handle Errors**: Gracefully handle permission denials and errors
4. **Cleanup**: Remove listeners in useEffect cleanup
5. **Quality Settings**: Use appropriate quality settings for images/videos
6. **Haptics Sparingly**: Use haptics for important interactions only
7. **Test on Device**: Always test camera, notifications, and haptics on real devices
