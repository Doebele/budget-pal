// Zentraler Icon-Adapter — iconoir-react mit `size`-Prop-Kompatibilität.
// Generiert via scripts/migrate-icons.mjs; neue Icons hier ergänzen.
import { forwardRef } from "react";
import type { ComponentType, ForwardRefExoticComponent, Ref, RefAttributes, SVGProps } from "react";
import * as Iconoir from "iconoir-react";

export type IconProps = SVGProps<SVGSVGElement> & { size?: number | string };

/** Komponententyp für Icon-Konfigurationen (ersetzt lucides `LucideIcon`). */
export type IconComponent = ComponentType<IconProps>;

type IconoirIcon = ForwardRefExoticComponent<SVGProps<SVGSVGElement> & RefAttributes<SVGSVGElement>>;

function withSize(Icon: IconoirIcon, name: string) {
  const Wrapped = forwardRef(function WrappedIcon(
    { size, ...props }: IconProps,
    ref: Ref<SVGSVGElement>
  ) {
    return (
      <Icon
        ref={ref}
        {...props}
        width={size ?? props.width}
        height={size ?? props.height}
      />
    );
  });
  Wrapped.displayName = name;
  return Wrapped;
}

export const Activity = withSize(Iconoir.Activity, "Activity");
export const Airplane = withSize(Iconoir.Airplane, "Airplane");
export const Archive = withSize(Iconoir.Archive, "Archive");
export const ArrowDownRight = withSize(Iconoir.ArrowDownRight, "ArrowDownRight");
export const ArrowRight = withSize(Iconoir.ArrowRight, "ArrowRight");
export const ArrowUpRight = withSize(Iconoir.ArrowUpRight, "ArrowUpRight");
export const Bank = withSize(Iconoir.Bank, "Bank");
export const Bell = withSize(Iconoir.Bell, "Bell");
export const BellNotification = withSize(Iconoir.BellNotification, "BellNotification");
export const BitcoinCircle = withSize(Iconoir.BitcoinCircle, "BitcoinCircle");
export const BookStack = withSize(Iconoir.BookStack, "BookStack");
export const Brain = withSize(Iconoir.Brain, "Brain");
export const Building = withSize(Iconoir.Building, "Building");
export const Calendar = withSize(Iconoir.Calendar, "Calendar");
export const Car = withSize(Iconoir.Car, "Car");
export const Cart = withSize(Iconoir.Cart, "Cart");
export const Cash = withSize(Iconoir.Cash, "Cash");
export const Check = withSize(Iconoir.Check, "Check");
export const CheckCircle = withSize(Iconoir.CheckCircle, "CheckCircle");
export const CheckSquare = withSize(Iconoir.CheckSquare, "CheckSquare");
export const Clock = withSize(Iconoir.Clock, "Clock");
export const Cloud = withSize(Iconoir.Cloud, "Cloud");
export const Coins = withSize(Iconoir.Coins, "Coins");
export const Community = withSize(Iconoir.Community, "Community");
export const Component = withSize(Iconoir.Component, "Component");
export const CreditCard = withSize(Iconoir.CreditCard, "CreditCard");
export const DashboardDots = withSize(Iconoir.DashboardDots, "DashboardDots");
export const DashboardSpeed = withSize(Iconoir.DashboardSpeed, "DashboardSpeed");
export const DataTransferBoth = withSize(Iconoir.DataTransferBoth, "DataTransferBoth");
export const Database = withSize(Iconoir.Database, "Database");
export const Dollar = withSize(Iconoir.Dollar, "Dollar");
export const Download = withSize(Iconoir.Download, "Download");
export const Drag = withSize(Iconoir.Drag, "Drag");
export const EditPencil = withSize(Iconoir.EditPencil, "EditPencil");
export const Eye = withSize(Iconoir.Eye, "Eye");
export const EyeClosed = withSize(Iconoir.EyeClosed, "EyeClosed");
export const Flask = withSize(Iconoir.Flask, "Flask");
export const FloppyDisk = withSize(Iconoir.FloppyDisk, "FloppyDisk");
export const GitMerge = withSize(Iconoir.GitMerge, "GitMerge");
export const Globe = withSize(Iconoir.Globe, "Globe");
export const GraduationCap = withSize(Iconoir.GraduationCap, "GraduationCap");
export const GraphDown = withSize(Iconoir.GraphDown, "GraphDown");
export const GraphUp = withSize(Iconoir.GraphUp, "GraphUp");
export const Group = withSize(Iconoir.Group, "Group");
export const HalfMoon = withSize(Iconoir.HalfMoon, "HalfMoon");
export const Heart = withSize(Iconoir.Heart, "Heart");
export const Home = withSize(Iconoir.Home, "Home");
export const InfoCircle = withSize(Iconoir.InfoCircle, "InfoCircle");
export const Journal = withSize(Iconoir.Journal, "Journal");
export const Label = withSize(Iconoir.Label, "Label");
export const Laptop = withSize(Iconoir.Laptop, "Laptop");
export const LightBulb = withSize(Iconoir.LightBulb, "LightBulb");
export const LogOut = withSize(Iconoir.LogOut, "LogOut");
export const MagicWand = withSize(Iconoir.MagicWand, "MagicWand");
export const MapPin = withSize(Iconoir.MapPin, "MapPin");
export const Menu = withSize(Iconoir.Menu, "Menu");
export const Minus = withSize(Iconoir.Minus, "Minus");
export const Movie = withSize(Iconoir.Movie, "Movie");
export const MusicDoubleNote = withSize(Iconoir.MusicDoubleNote, "MusicDoubleNote");
export const NavArrowDown = withSize(Iconoir.NavArrowDown, "NavArrowDown");
export const NavArrowLeft = withSize(Iconoir.NavArrowLeft, "NavArrowLeft");
export const NavArrowRight = withSize(Iconoir.NavArrowRight, "NavArrowRight");
export const NavArrowUp = withSize(Iconoir.NavArrowUp, "NavArrowUp");
export const OpenBook = withSize(Iconoir.OpenBook, "OpenBook");
export const OpenNewWindow = withSize(Iconoir.OpenNewWindow, "OpenNewWindow");
export const Page = withSize(Iconoir.Page, "Page");
export const PageUp = withSize(Iconoir.PageUp, "PageUp");
export const PercentageCircle = withSize(Iconoir.PercentageCircle, "PercentageCircle");
export const PiggyBank = withSize(Iconoir.PiggyBank, "PiggyBank");
export const Plus = withSize(Iconoir.Plus, "Plus");
export const Position = withSize(Iconoir.Position, "Position");
export const Refresh = withSize(Iconoir.Refresh, "Refresh");
export const Repeat = withSize(Iconoir.Repeat, "Repeat");
export const Reports = withSize(Iconoir.Reports, "Reports");
export const Scissor = withSize(Iconoir.Scissor, "Scissor");
export const Search = withSize(Iconoir.Search, "Search");
export const Settings = withSize(Iconoir.Settings, "Settings");
export const Key = withSize(Iconoir.Key, "Key");
export const Shield = withSize(Iconoir.Shield, "Shield");
export const ShieldCheck = withSize(Iconoir.ShieldCheck, "ShieldCheck");
export const ShoppingBag = withSize(Iconoir.ShoppingBag, "ShoppingBag");
export const Shuffle = withSize(Iconoir.Shuffle, "Shuffle");
export const SmartphoneDevice = withSize(Iconoir.SmartphoneDevice, "SmartphoneDevice");
export const SidebarCollapse = withSize(Iconoir.SidebarCollapse, "SidebarCollapse");
export const Sofa = withSize(Iconoir.Sofa, "Sofa");
export const Sparks = withSize(Iconoir.Sparks, "Sparks");
export const Square = withSize(Iconoir.Square, "Square");
export const StatsReport = withSize(Iconoir.StatsReport, "StatsReport");
export const Suitcase = withSize(Iconoir.Suitcase, "Suitcase");
export const SunLight = withSize(Iconoir.SunLight, "SunLight");
export const Table = withSize(Iconoir.Table, "Table");
export const TableRows = withSize(Iconoir.TableRows, "TableRows");
export const Train = withSize(Iconoir.Train, "Train");
export const Trash = withSize(Iconoir.Trash, "Trash");
export const Trophy = withSize(Iconoir.Trophy, "Trophy");
export const Tv = withSize(Iconoir.Tv, "Tv");
export const Undo = withSize(Iconoir.Undo, "Undo");
export const Upload = withSize(Iconoir.Upload, "Upload");
export const User = withSize(Iconoir.User, "User");
export const UserXmark = withSize(Iconoir.UserXmark, "UserXmark");
export const ViewGrid = withSize(Iconoir.ViewGrid, "ViewGrid");
export const Wallet = withSize(Iconoir.Wallet, "Wallet");
export const WarningCircle = withSize(Iconoir.WarningCircle, "WarningCircle");
export const WarningTriangle = withSize(Iconoir.WarningTriangle, "WarningTriangle");
export const Xmark = withSize(Iconoir.Xmark, "Xmark");
