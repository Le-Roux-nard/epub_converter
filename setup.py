import setuptools

with open('requirements.txt') as f:
    requirements = f.read()

setuptools.setup(
    name='epub-converter',
    version='1.0',
    description='Simple webserver to create and serve epub files',
    url='https://github.com/Le_Roux-nard/mkepub/',
    author='anqxyr, Le_Roux-nard',
    author_email='contact@lerouxnard.fr',
    license='MIT',
    classifiers=[
        'Development Status :: 5 - Production/Stable',
        'Intended Audience :: Developers',
        'License :: OSI Approved :: MIT License',
        'Operating System :: OS Independent',
        'Programming Language :: Python :: 3.12'],
    packages=['./'],
    install_requires=requirements.split("\n"),
)
