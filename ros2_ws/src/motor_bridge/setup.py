from setuptools import setup

package_name = 'motor_bridge'

setup(
    name=package_name,
    version='0.0.1',
    packages=[package_name],
    install_requires=['setuptools'],
    zip_safe=True,
    entry_points={
        'console_scripts': [
            'serial_bridge = motor_bridge.serial_bridge:main',
	    'coverage_benchmark = motor_bridge.coverage_benchmark:main',
	    'frontier_explorer = motor_bridge.frontier_explorer:main',
	    'safety_layer = motor_bridge.safety_layer:main',
            'pid_tuner = motor_bridge.pid_tuner:main',
            'map_saver = motor_bridge.map_saver:main',
	    'imu_node = motor_bridge.imu_node:main',
        ],
    },
)

