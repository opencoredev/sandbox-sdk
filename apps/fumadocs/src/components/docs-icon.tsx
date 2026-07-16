import {
  ArtificialIntelligence04Icon,
  GridViewIcon,
  PlugSocketIcon,
  ServerStack01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const iconProps = {
  "aria-hidden": true,
  fill: "none",
  xmlns: "http://www.w3.org/2000/svg",
} as const;

export function ProviderLogo({ id, ...props }: IconProps & { id: string }) {
  switch (id) {
    case "agentos":
      return <HugeiconsIcon icon={ServerStack01Icon} className={props.className} />;
    case "e2b":
      return <E2BLogo {...props} />;
    case "daytona":
      return <DaytonaLogo {...props} />;
    case "vercel":
      return <VercelLogo {...props} />;
    case "upstash":
      return <UpstashLogo {...props} />;
    case "railway":
      return <RailwayLogo {...props} />;
    default:
      return <HugeiconsIcon icon={ServerStack01Icon} className={props.className} />;
  }
}

export function resolveDocsIcon(icon: string | undefined): ReactNode {
  switch (icon) {
    case "providers":
      return <HugeiconsIcon icon={GridViewIcon} />;
    case "local":
    case "agentos":
    case "e2b":
    case "daytona":
    case "vercel":
    case "upstash":
    case "railway":
      return <ProviderLogo id={icon} />;
    case "integrations":
      return <HugeiconsIcon icon={PlugSocketIcon} />;
    case "ai-sdk":
    case "ai-sdk-harness":
      return <VercelLogo />;
    case "eve":
      return <EveLogo />;
    case "mastra":
      return <MastraLogo />;
    case "agent-skill":
      return <HugeiconsIcon icon={ArtificialIntelligence04Icon} />;
    default:
      return undefined;
  }
}

function E2BLogo(props: IconProps) {
  return (
    <svg {...iconProps} {...props} viewBox="0 0 224 232">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M188.212 157.998c-1.54 0-2.502 1.667-1.732 3l16.105 27.896c.891 1.543-.529 3.393-2.25 2.932l-48.844-13.089a4 4 0 0 0-4.899 2.829l-13.088 48.845c-.462 1.721-2.773 2.025-3.664.482l-16.108-27.901c-.77-1.333-2.695-1.333-3.464 0L94.16 230.893c-.891 1.543-3.203 1.239-3.664-.482l-13.088-48.845a4 4 0 0 0-4.899-2.829l-48.845 13.089c-1.721.461-3.14-1.389-2.25-2.932l16.105-27.896c.77-1.333-.192-3-1.732-3H3.579c-1.782 0-2.674-2.154-1.414-3.414l35.757-35.757a4 4 0 0 0 0-5.656L2.165 77.413C.905 76.153 1.797 74 3.579 74h32.205c1.539 0 2.502-1.667 1.732-3L21.414 43.11c-.89-1.543.529-3.393 2.25-2.932l48.845 13.088a4 4 0 0 0 4.899-2.828L90.496 1.593c.461-1.721 2.773-2.026 3.664-.482l16.107 27.9c.77 1.334 2.695 1.334 3.465 0l16.108-27.9c.89-1.544 3.202-1.24 3.663.482l13.089 48.845a4 4 0 0 0 4.899 2.828l48.844-13.088c1.721-.461 3.141 1.389 2.25 2.932l-16.102 27.89c-.77 1.333.193 3 1.732 3h32.206c1.782 0 2.674 2.154 1.414 3.414l-35.757 35.757a4 4 0 0 0 0 5.656l35.757 35.757c1.26 1.26.368 3.414-1.414 3.414zM175.919 81.33c1.447-1.446.044-3.875-1.932-3.345l-43.496 11.655a4 4 0 0 1-4.899-2.829l-11.661-43.518c-.529-1.976-3.334-1.976-3.863 0L98.407 86.811a4 4 0 0 1-4.899 2.829L50.014 77.985c-1.977-.53-3.379 1.899-1.932 3.346l31.84 31.84a4 4 0 0 1 0 5.657l-31.848 31.847c-1.447 1.447-.044 3.875 1.932 3.346l43.502-11.657a4 4 0 0 1 4.899 2.828l11.661 43.519c.529 1.976 3.334 1.976 3.863 0l11.661-43.519a4 4 0 0 1 4.899-2.828l43.503 11.657c1.977.53 3.379-1.899 1.932-3.346l-31.847-31.847a4 4 0 0 1 0-5.657z"
      />
    </svg>
  );
}

function DaytonaLogo(props: IconProps) {
  return (
    <svg {...iconProps} {...props} viewBox="0 0 275 287">
      <path
        fill="currentColor"
        d="M14.56 193.74h99.72v34.19H14.56zm133.9-119.66h113.97v34.19H148.46zM88.63 84.61 173.25 0l24.17 24.18-84.61 84.61zM89.16 170.08l-64.98-64.98L0 129.28l64.98 64.98zm85.47 47.83-68.5 68.5-24.17-24.18 68.49-68.49zm-.52-85.47 76.55 76.55 24.18-24.17-76.56-76.56zM88.63 48.43v82.63H54.45V48.43zm119.66 119.66v102.57h-34.18V168.09z"
      />
    </svg>
  );
}

function VercelLogo(props: IconProps) {
  return (
    <svg {...iconProps} {...props} viewBox="0 0 24 24">
      <path fill="currentColor" d="m12 1.608 12 20.784H0Z" />
    </svg>
  );
}

function UpstashLogo(props: IconProps) {
  return (
    <svg {...iconProps} {...props} viewBox="0 0 24 24">
      <path
        fill="currentColor"
        d="M13.803 0c-2.61 0-5.22.995-7.211 2.986-3.982 3.983-3.982 10.44 0 14.422a5.1 5.1 0 0 0 7.21-7.21L12 12a2.55 2.55 0 0 1-3.605 3.605A7.649 7.649 0 0 1 19.21 4.79l1.803-1.803A10.17 10.17 0 0 0 13.803 0M12 12a2.55 2.55 0 0 1 3.605-3.605A7.649 7.649 0 0 1 4.79 19.21l-1.803 1.803c3.983 3.982 10.44 3.982 14.422 0s3.982-10.44 0-14.422A5.08 5.08 0 0 0 13.803 5.1a5.1 5.1 0 0 0-3.605 8.703z"
      />
    </svg>
  );
}

function RailwayLogo(props: IconProps) {
  return (
    <svg {...iconProps} {...props} viewBox="0 0 24 24">
      <path
        fill="currentColor"
        d="M4 2h16a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2m1.5 3v5.25L12 16.5l6.5-6.25V5z"
      />
    </svg>
  );
}

function EveLogo(props: IconProps) {
  return (
    <svg {...iconProps} {...props} viewBox="0 0 102 102">
      <path
        fill="currentColor"
        d="m49.28 66.94 25.75-31.98h-6.89L47.91 60.11l-5.49 6.83zM0 34.96h42.4v5.11H0zm0 13.32h27.66v5.11H0zm0 13.54h27.66v5.11H0zm69.63-26.86h32.27v5.11H69.63zm4.61 13.32h27.66v5.11H74.24zm0 13.54h27.66v5.11H74.24z"
      />
    </svg>
  );
}

/**
 * Official Mastra mark:
 * https://github.com/mastra-ai/mastra/blob/main/packages/playground/public/mastra.svg
 */
function MastraLogo(props: IconProps) {
  return (
    <svg {...iconProps} {...props} viewBox="0 0 34 21">
      <path
        fill="currentColor"
        d="M4.49805 11.6934C6.98237 11.6934 8.99609 13.7081 8.99609 16.1924C8.9959 18.6765 6.98225 20.6904 4.49805 20.6904C2.01394 20.6903 0.000196352 18.6765 0 16.1924C0 13.7081 2.01382 11.6935 4.49805 11.6934ZM10.3867 0C12.8709 0 14.8846 2.01388 14.8848 4.49805C14.8848 4.8377 14.847 5.16846 14.7755 5.48643C14.4618 6.88139 14.1953 8.4633 14.9928 9.65L16.2575 11.5319C16.3363 11.6491 16.4727 11.7115 16.6137 11.703C16.7369 11.6957 16.8525 11.6343 16.9214 11.5318L18.1876 9.64717C18.9772 8.47198 18.7236 6.90783 18.4205 5.52484C18.3523 5.21392 18.3164 4.89094 18.3164 4.55957C18.3167 2.07546 20.3313 0.0615234 22.8154 0.0615234C25.2994 0.0617476 27.3132 2.0756 27.3135 4.55957C27.3135 4.93883 27.2665 5.30712 27.178 5.65896C26.8547 6.94441 26.5817 8.37932 27.2446 9.52714L28.459 11.6301C28.4819 11.6697 28.5245 11.6934 28.5703 11.6934C31.0545 11.6935 33.0684 13.7081 33.0684 16.1924C33.0682 18.6765 31.0544 20.6903 28.5703 20.6904C26.0861 20.6904 24.0725 18.6765 24.0723 16.1924C24.0723 15.8049 24.1212 15.4288 24.2133 15.0701C24.5458 13.7746 24.8298 12.3251 24.1609 11.1668L23.0044 9.16384C22.9656 9.09659 22.8931 9.05859 22.8154 9.05859C22.7983 9.05859 22.7824 9.06614 22.7728 9.08033L21.4896 10.9895C20.686 12.1851 20.9622 13.781 21.284 15.1851C21.3582 15.5089 21.3975 15.8461 21.3975 16.1924C21.3973 18.6764 19.3834 20.6902 16.8994 20.6904C14.4152 20.6904 12.4006 18.6765 12.4004 16.1924C12.4004 15.932 12.4226 15.6768 12.4651 15.4286C12.6859 14.14 12.8459 12.7122 12.1167 11.6271L11.2419 10.3253C10.6829 9.49347 9.71913 9.05932 8.78286 8.70188C7.0906 8.05584 5.88867 6.41734 5.88867 4.49805C5.88886 2.0139 7.90254 3.29835e-05 10.3867 0Z"
      />
    </svg>
  );
}
