// Platform icons from Beszel's dashboard (internal/site/src/components/ui/icons.tsx, MIT),
// which credits: Tux/Docker ionicons (MIT), Windows IconPark (Apache 2.0),
// Apple teenyicons (MIT), FreeBSD Material Design Icons (Apache 2.0).
import type { SVGProps } from "react";

export function TuxIcon(props: SVGProps<SVGSVGElement>) {
	return (
		<svg aria-hidden="true" viewBox="0 0 256 256" {...props}>
			<path
				fill="currentColor"
				d="M231 217a12 12 0 0 1-16-2c-2-1-35-44-35-127a52 52 0 1 0-104 0c0 83-33 126-35 127a12 12 0 0 1-18-14c0-1 29-39 29-113a76 76 0 1 1 152 0c0 74 29 112 29 113a12 12 0 0 1-2 16m-127-97a16 16 0 1 0-16-16 16 16 0 0 0 16 16m64-16a16 16 0 1 0-16 16 16 16 0 0 0 16-16m-73 51 28 12a12 12 0 0 0 10 0l28-12a12 12 0 0 0-10-22l-23 10-23-10a12 12 0 0 0-10 22m33 29a57 57 0 0 0-39 15 12 12 0 0 0 17 18 33 33 0 0 1 44 0 12 12 0 1 0 17-18 57 57 0 0 0-39-15"
			/>
		</svg>
	);
}

export function WindowsIcon(props: SVGProps<SVGSVGElement>) {
	return (
		<svg aria-hidden="true" viewBox="0 0 48 48" {...props}>
			<path fill="none" stroke="currentColor" strokeWidth="3.8" d="m6.8 11 12.9-1.7v12.1h-13zm18-2.2 16.4-2v14.6H25zm0 18.6 16.4.4v13.4L25 38.6zm-18-.8 12.9.3v10.9l-13-2.2z" />
		</svg>
	);
}

export function AppleIcon(props: SVGProps<SVGSVGElement>) {
	return (
		<svg aria-hidden="true" viewBox="0 0 20 20" {...props}>
			<path
				fill="currentColor"
				d="M14.1 4.7a5 5 0 0 1 3.8 2c-3.3 1.9-2.8 6.7.6 8L17.2 17c-.8 1.3-2 2.9-3.5 2.9-1.2 0-1.6-.9-3.3-.8s-2.2.8-3.5.8c-1.4 0-2.5-1.5-3.4-2.7-2.3-3.6-2.5-7.9-1.1-10 1-1.7 2.6-2.6 4.1-2.6 1.6 0 2.6.8 3.8.8 1.3 0 2-.8 3.8-.8M13.7 0c.2 1.2-.3 2.4-1 3.2a4 4 0 0 1-3 1.6c-.2-1.2.3-2.3 1-3.2.7-.8 2-1.5 3-1.6"
			/>
		</svg>
	);
}

export function FreeBsdIcon(props: SVGProps<SVGSVGElement>) {
	return (
		<svg aria-hidden="true" viewBox="0 0 24 24" {...props}>
			<path
				fill="currentColor"
				d="M2.7 2C3.5 2 6 3.2 6 3.2 4.8 4 3.7 5 3 6.4 2.1 4.8 1.3 2.9 2 2.2l.7-.2m18.1.1c.4 0 .8 0 1 .2 1 1.1-2 5.8-2.4 6.4-.5.5-1.8 0-2.9-1-1-1.2-1.5-2.4-1-3 .4-.4 3.6-2.4 5.3-2.6m-8.8.5c1.3 0 2.5.2 3.7.7l-1 .7c-1 1-.6 2.8 1 4.4 1 1 2.1 1.6 3 1.6a2 2 0 0 0 1.5-.6l.7-1a9.7 9.7 0 1 1-18.6 3.8A9.7 9.7 0 0 1 12 2.7"
			/>
		</svg>
	);
}

export function DockerIcon(props: SVGProps<SVGSVGElement>) {
	return (
		<svg aria-hidden="true" viewBox="0 0 512 512" fill="currentColor" {...props}>
			<path d="M507 211c-1-1-14-11-42-11a133 133 0 0 0-21 2c-6-36-36-54-37-55l-7-4-5 7a102 102 0 0 0-13 30c-5 21-2 40 8 57-12 7-33 9-37 9H16a16 16 0 0 0-16 16 241 241 0 0 0 15 87c11 30 29 53 51 67 25 15 66 24 113 24a344 344 0 0 0 62-6 257 257 0 0 0 82-29 224 224 0 0 0 55-46c27-30 43-64 55-94h4c30 0 48-12 58-22a63 63 0 0 0 15-22l2-6Z" />
			<path d="M47 236h45a4 4 0 0 0 4-4v-40a4 4 0 0 0-4-4H47a4 4 0 0 0-4 4v40a4 4 0 0 0 4 4m63 0h45a4 4 0 0 0 4-4v-40a4 4 0 0 0-4-4h-45a4 4 0 0 0-4 4v40a4 4 0 0 0 4 4m63 0h45a4 4 0 0 0 4-4v-40a4 4 0 0 0-4-4h-45a4 4 0 0 0-4 4v40a4 4 0 0 0 4 4m62 0h45a4 4 0 0 0 4-4v-40a4 4 0 0 0-4-4h-45a4 4 0 0 0-4 4v40a4 4 0 0 0 4 4m-125-57h45a4 4 0 0 0 4-4v-41a4 4 0 0 0-4-4h-45a4 4 0 0 0-4 4v41a4 4 0 0 0 4 4m63 0h45a4 4 0 0 0 4-4v-41a4 4 0 0 0-4-4h-45a4 4 0 0 0-4 4v41a4 4 0 0 0 4 4m62 0h45a4 4 0 0 0 4-4v-41a4 4 0 0 0-4-4h-45a4 4 0 0 0-4 4v41a4 4 0 0 0 4 4m0-58h45a4 4 0 0 0 4-4V76a4 4 0 0 0-4-4h-45a4 4 0 0 0-4 4v40a4 4 0 0 0 4 4m63 116h45a4 4 0 0 0 4-4v-40a4 4 0 0 0-4-4h-45a4 4 0 0 0-4 4v40a4 4 0 0 0 4 4" />
		</svg>
	);
}
