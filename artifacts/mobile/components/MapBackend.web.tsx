import React from "react";
import { View } from "react-native";

export const MapView: React.FC<any> = ({ children, style }) => (
  <View style={style}>{children}</View>
);
export const Marker: React.FC<any> = () => null;
export const PROVIDER_DEFAULT = undefined as unknown as string;
export const HAS_MAPS = false;
